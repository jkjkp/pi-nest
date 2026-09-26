import { describe, expect, it } from 'vitest'

import { formatActivityDuration, formatElapsedTime, nextExecutionExpanded, projectTurnPresentation, turnCompletedAt, turnElapsed } from './turn-execution-model.js'
import { timelineItems, type TimelineEvent, type TimelineItem, type TimelinePart } from './timeline-model.js'

function event(type: string, second: number, fields: Record<string, unknown> = {}): TimelineEvent {
  return { event: { type, ...fields }, id: `${type}-${second}`, observedAt: `2026-09-22T00:00:${String(second).padStart(2, '0')}.000Z`, raw: { type, ...fields } }
}

function item(parts: TimelinePart[], events = parts.flatMap((part) => part.events)): TimelineItem {
  return { diagnostics: [], events, id: 'turn-1', kind: 'turn', parts, prompt: 'go', startedAt: '2026-09-22T00:00:00.000Z' }
}

function text(value: string, second: number): Extract<TimelinePart, { kind: 'assistant_text' }> { const entry = event('message', second); return { events: [entry], kind: 'assistant_text', text: value } }
function thinking(value: string, second: number): Extract<TimelinePart, { kind: 'thinking' }> { const entry = event('message_update', second); return { events: [entry], kind: 'thinking', text: value } }
function tool(name: string, second: number): Extract<TimelinePart, { kind: 'tool' }> { const entry = event('tool_execution_start', second, { path: 'apps/web/src/session-timeline.tsx', toolName: name }); return { events: [entry], kind: 'tool', toolCallId: 'call-1', toolName: name } }
function bash(second: number): Extract<TimelinePart, { kind: 'bash' }> { return { events: [event('bash_execution_start', second, { command: 'pnpm test' }), event('bash_execution_end', second + 8, { command: 'pnpm test', exitCode: 0, stdout: '65 passed' })], kind: 'bash' } }

describe('projectTurnPresentation', () => {
  it('keeps execution activities ordered and places post-execution assistant text in the final answer', () => {
    const presentation = projectTurnPresentation(item([thinking('checking', 1), tool('read_file', 2), thinking('editing', 3), bash(4), { events: [event('file_changes', 13, { changes: [{ added: 2, path: 'a.ts', removed: 1 }] })], kind: 'file_change' }, text('final', 14)]), false)

    expect(presentation.activities.map((activity) => activity.kind)).toEqual(['thinking', 'tool', 'thinking', 'bash', 'file_change'])
    expect(presentation.finalAnswer.map((part) => part.text)).toEqual(['final'])
    expect(presentation.activities.find((activity) => activity.kind === 'tool')).toMatchObject({ label: '读取 apps/web/src/session-timeline.tsx' })
    expect(presentation.activities.find((activity) => activity.kind === 'bash')).toMatchObject({ command: 'pnpm test', status: '完成' })
  })

  it('keeps narration before execution out of the final answer', () => {
    const presentation = projectTurnPresentation(item([text('narration', 1), tool('search', 2), thinking('reasoning', 3), text('final', 4)]), false)

    expect(presentation.activities).toMatchObject([{ kind: 'narration', text: 'narration' }, { kind: 'tool' }, { kind: 'thinking' }])
    expect(presentation.finalAnswer.map((part) => part.text)).toEqual(['final'])
  })

  it('uses all assistant text as the final answer when no execution occurred', () => {
    const presentation = projectTurnPresentation(item([text('one', 1), text('two', 2)]), false)

    expect(presentation.hasExecution).toBe(false)
    expect(presentation.activities).toEqual([])
    expect(presentation.finalAnswer.map((part) => part.text)).toEqual(['one', 'two'])
  })

  it('does not promote pre-execution narration to a running final answer', () => {
    const presentation = projectTurnPresentation(item([text('narration', 1), tool('read_file', 2), thinking('working', 3)]), true)

    expect(presentation.finalAnswer).toEqual([])
    expect(presentation.activities.map((activity) => activity.kind)).toEqual(['narration', 'tool', 'thinking'])
  })

  it('falls back to the last assistant text for completed turns without a post-execution answer', () => {
    const presentation = projectTurnPresentation(item([text('narration', 1), tool('read_file', 2), thinking('working', 3)]), false)

    expect(presentation.finalAnswer.map((part) => part.text)).toEqual(['narration'])
    expect(presentation.activities.map((activity) => activity.kind)).toEqual(['tool', 'thinking'])
  })

  it('keeps tool durations and an understandable fallback for unknown tools', () => {
    const events = [event('tool_execution_start', 1, { toolName: 'custom_tool' }), event('tool_execution_end', 3, { toolName: 'custom_tool' })]
    const presentation = projectTurnPresentation(item([{ events, kind: 'tool', toolCallId: 'call-1', toolName: 'custom_tool' }]), false)

    expect(presentation.activities).toMatchObject([{ duration: 2_000, kind: 'tool', label: 'Custom Tool', status: '完成' }])
  })

  it('labels a persisted command from the native toolCall arguments', () => {
    const [persisted] = timelineItems([
      { id: 'user-1', parentId: null, raw: { message: { content: 'run tests', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'message' },
      { id: 'assistant-1', parentId: 'user-1', raw: { message: { content: [{ arguments: { command: 'pnpm test' }, id: 'call-1', name: 'bash', type: 'toolCall' }], role: 'assistant' }, type: 'message' }, timestamp: '2026-09-22T00:00:01.000Z', type: 'message' },
      { id: 'tool-1', parentId: 'assistant-1', raw: { message: { content: [], isError: false, role: 'toolResult', toolCallId: 'call-1', toolName: 'bash' }, type: 'message' }, timestamp: '2026-09-22T00:00:02.000Z', type: 'message' },
    ], [], [])

    expect(projectTurnPresentation(persisted!, false).activities).toMatchObject([{ kind: 'tool', label: '运行 pnpm test', status: '完成' }])
  })

  it('keeps persisted execution semantically equivalent to its live projection after refresh', () => {
    const live = item([thinking('checking files', 1), tool('read', 2), text('final answer', 3)])
    const [persisted] = timelineItems([
      { id: 'user-1', parentId: null, raw: { message: { content: 'question', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'message' },
      { id: 'assistant-1', parentId: 'user-1', raw: { message: { content: [{ thinking: 'checking files', type: 'thinking' }, { id: 'call-1', name: 'read', type: 'toolCall' }], role: 'assistant' }, type: 'message' }, timestamp: '2026-09-22T00:00:01.000Z', type: 'message' },
      { id: 'tool-1', parentId: 'assistant-1', raw: { message: { content: [], isError: false, role: 'toolResult', toolCallId: 'call-1', toolName: 'read' }, type: 'message' }, timestamp: '2026-09-22T00:00:02.000Z', type: 'message' },
      { id: 'assistant-2', parentId: 'tool-1', raw: { message: { content: [{ text: 'final answer', type: 'text' }], role: 'assistant' }, type: 'message' }, timestamp: '2026-09-22T00:00:03.000Z', type: 'message' },
    ], [], [])

    const livePresentation = projectTurnPresentation(live, false)
    const persistedPresentation = projectTurnPresentation(persisted!, false)
    expect(persistedPresentation.hasExecution).toBe(true)
    expect(persistedPresentation.activities.map((activity) => activity.kind)).toEqual(livePresentation.activities.map((activity) => activity.kind))
    expect(persistedPresentation.finalAnswer.map((part) => part.text)).toEqual(['final answer'])
  })
})

describe('turn elapsed time', () => {
  it('uses a terminal event for total completed Turn duration and falls back to the final observed event', () => {
    const ended = item([], [event('message_update', 1), event('turn_end', 45)])
    const fallback = item([], [event('message_update', 12)])

    expect(turnCompletedAt(ended)).toBe('2026-09-22T00:00:45.000Z')
    expect(turnElapsed(ended, false)).toBe(45_000)
    expect(turnElapsed(fallback, false)).toBe(12_000)
  })

  it('uses browser-clock runtime timing through completion instead of falling back to event time', () => {
    const completed = {
      ...item([], [event('turn_end', 12)]),
      runtimeTiming: { completedAt: '2026-09-22T00:00:26.000Z', startedAt: '2026-09-22T00:00:00.000Z' },
    }

    expect(turnElapsed(completed, true, Date.parse('2026-09-22T00:00:25.000Z'))).toBe(25_000)
    expect(turnElapsed(completed, false)).toBe(26_000)
  })

  it('does not make duration go backwards when persisted history replaces a completed live turn', () => {
    const [persisted] = timelineItems([
      { id: 'user-1', parentId: null, raw: { message: { content: 'go', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:05.000Z', type: 'message' },
      { id: 'turn-end', parentId: 'user-1', raw: { type: 'turn_end' }, timestamp: '2026-09-22T00:00:12.000Z', type: 'turn_end' },
    ], [{ completedAt: '2026-09-22T00:00:26.000Z', events: [], historyTurnCount: 0, id: 'pending:session-1', prompt: 'go', startedAt: '2026-09-22T00:00:00.000Z' }], [])

    expect(turnElapsed(persisted!, false)).toBe(26_000)
  })

  it('formats Turn and short activity durations for people', () => {
    expect(formatElapsedTime(8_000)).toBe('8秒')
    expect(formatElapsedTime(65_000)).toBe('1分05秒')
    expect(formatElapsedTime(3_735_000)).toBe('1小时02分15秒')
    expect(formatActivityDuration(850)).toBe('850 ms')
  })

  it('collapses on completion only when the user has not chosen an execution state', () => {
    expect(nextExecutionExpanded(true, true, false, false)).toBe(false)
    expect(nextExecutionExpanded(false, true, false, true)).toBe(false)
    expect(nextExecutionExpanded(true, true, false, true)).toBe(true)
  })
})
