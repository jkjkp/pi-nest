import { describe, expect, it } from 'vitest'

import { diagnosticLabel, duration, timelineItems, timelineNavigationEntries, toolStatus } from './timeline-model.js'

const runtime = (sequence: number, event: Record<string, unknown>, turnId = 'turn-1') => ({ event, observedAt: `2026-09-22T00:00:${String(sequence).padStart(2, '0')}.000Z`, sequence, sessionId: 'session-1', turnId })

describe('timelineItems', () => {
  it('keeps every persisted turn and navigation entry from a long history', () => {
    const history = Array.from({ length: 300 }, (_, index) => ({
      id: `user-${index}`,
      parentId: index === 0 ? null : `user-${index - 1}`,
      raw: { message: { content: `question ${index}`, role: 'user' }, type: 'message' },
      timestamp: `2026-09-22T00:${String(index).padStart(2, '0')}:00.000Z`,
      type: 'message',
    }))

    const items = timelineItems(history, [], [])
    const navigation = timelineNavigationEntries(items)

    expect(items).toHaveLength(300)
    expect(navigation).toHaveLength(300)
    expect(navigation[0]).toMatchObject({ id: 'user-0', index: 1 })
    expect(navigation.at(-1)).toMatchObject({ id: 'user-299', index: 300 })
  })

  it('projects a clean activity timeline while retaining every raw event in technical details', () => {
    const events = [
      runtime(1, { type: 'message_update', assistantMessageEvent: { delta: 'Hello', type: 'text_delta' } }),
      runtime(2, { type: 'message', message: { content: [{ text: 'Hello', type: 'text' }], role: 'assistant' } }),
      runtime(3, { type: 'message_update', assistantMessageEvent: { delta: 'reasoning', type: 'thinking_delta' } }),
      runtime(4, { toolCallId: 'call-1', toolName: 'bash', type: 'tool_execution_start' }),
      runtime(5, { isError: false, toolCallId: 'call-1', toolName: 'bash', type: 'tool_execution_end' }),
      runtime(6, { command: 'pwd', cwd: '/fixture', stderr: '', stdout: '/fixture', type: 'bash_execution_update' }),
      runtime(7, { changes: [{ added: 2, path: 'a.ts', removed: 1 }], type: 'file_changes' }),
      runtime(8, { type: 'custom', payload: { retained: true } }),
      runtime(9, { model: 'next', type: 'model_change' }),
      runtime(10, { message: { content: [], role: 'assistant' }, type: 'message' }),
      runtime(11, { type: 'turn_end' }),
    ]
    const [turn] = timelineItems(undefined, [{ events, id: 'turn-1', prompt: 'go', startedAt: '2026-09-22T00:00:00.000Z' }], [])

    expect(turn).toMatchObject({ kind: 'turn', prompt: 'go' })
    expect(turn?.parts.map((part) => part.kind)).toEqual(['assistant_text', 'thinking', 'tool', 'bash', 'file_change'])
    expect(turn?.parts[0]).toMatchObject({ text: 'Hello' })
    expect(turn?.events).toHaveLength(events.length)
    expect(turn?.diagnostics.map(diagnosticLabel)).toEqual([
      '未识别的 Pi 事件：custom',
      '运行元数据：model_change',
      '未展示的消息记录：message',
      '运行元数据：turn_end',
    ])
  })

  it('replaces streamed assistant text with its final form without duplicate content', () => {
    const [turn] = timelineItems(undefined, [{
      events: [
        runtime(1, { type: 'message_update', assistantMessageEvent: { delta: 'Hel', type: 'text_delta' } }),
        runtime(2, { type: 'message_update', assistantMessageEvent: { delta: 'thought', type: 'thinking_delta' } }),
        runtime(3, { type: 'message', message: { content: [{ text: 'Hello', type: 'text' }], role: 'assistant' } }),
        runtime(4, { type: 'message', message: { content: [{ text: 'Next', type: 'text' }], role: 'assistant' } }),
      ],
      id: 'turn-1',
      prompt: 'go',
      startedAt: '2026-09-22T00:00:00.000Z',
    }], [])

    expect(turn?.parts.filter((part) => part.kind === 'assistant_text').map((part) => part.kind === 'assistant_text' ? part.text : '')).toEqual(['Hello', 'Next'])
  })

  it('keeps historical unknown and metadata entries in the owning turn diagnostics', () => {
    const [turn] = timelineItems([
      { id: 'model-1', parentId: null, raw: { id: 'model-1', provider: 'pi', type: 'model_change' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'model_change' },
      { id: 'user-1', parentId: null, raw: { id: 'user-1', message: { content: 'question', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:01.000Z', type: 'message' },
      { id: 'unknown-1', parentId: 'user-1', raw: { id: 'unknown-1', payload: { all: 'retained' }, type: 'custom' }, timestamp: '2026-09-22T00:00:02.000Z', type: 'custom' },
      { id: 'assistant-1', parentId: 'user-1', raw: { id: 'assistant-1', message: { content: [{ text: 'answer', type: 'text' }], role: 'assistant' }, type: 'message' }, timestamp: '2026-09-22T00:00:03.000Z', type: 'message' },
      { id: 'end-1', parentId: 'user-1', raw: { id: 'end-1', type: 'agent_settled' }, timestamp: '2026-09-22T00:00:04.000Z', type: 'agent_settled' },
      { id: 'edit-1', parentId: 'end-1', raw: { id: 'edit-1', type: 'context_edit', targetId: 'assistant-1', replacement: null }, timestamp: '2026-09-22T00:00:05.000Z', type: 'context_edit' },
    ], [], [])

    expect(turn).toMatchObject({ kind: 'turn', prompt: 'question' })
    expect(turn?.parts.map((part) => part.kind)).toEqual(['assistant_text'])
    expect(turn?.diagnostics.map(diagnosticLabel)).toEqual(['未识别的 Pi 事件：custom', '运行元数据：agent_settled', '运行元数据：context_edit'])
    expect(turn?.events.map((event) => event.id)).toEqual(['user-1', 'unknown-1', 'assistant-1', 'end-1', 'edit-1'])
  })

  it('projects persisted thinking, tool calls, and tool results into execution parts in source order', () => {
    const [turn] = timelineItems([
      { id: 'user-1', parentId: null, raw: { message: { content: 'question', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'message' },
      { id: 'assistant-1', parentId: 'user-1', raw: { message: { content: [{ thinking: 'checking files', type: 'thinking' }, { id: 'call-1', name: 'read', type: 'toolCall' }], role: 'assistant' }, type: 'message' }, timestamp: '2026-09-22T00:00:01.000Z', type: 'message' },
      { id: 'tool-1', parentId: 'assistant-1', raw: { message: { content: [{ text: 'file contents', type: 'text' }], isError: false, role: 'toolResult', toolCallId: 'call-1', toolName: 'read' }, type: 'message' }, timestamp: '2026-09-22T00:00:02.000Z', type: 'message' },
      { id: 'assistant-2', parentId: 'tool-1', raw: { message: { content: [{ text: 'final answer', type: 'text' }], role: 'assistant' }, type: 'message' }, timestamp: '2026-09-22T00:00:03.000Z', type: 'message' },
    ], [], [])
    const tool = turn?.parts.find((part) => part.kind === 'tool')

    expect(turn?.parts.map((part) => part.kind)).toEqual(['thinking', 'tool', 'assistant_text'])
    expect(tool).toMatchObject({ toolCallId: 'call-1', toolName: 'read' })
    if (!tool || tool.kind !== 'tool') throw new Error('expected persisted tool')
    expect(toolStatus(tool.events)).toBe('完成')
    expect(duration(tool.events)).toBeUndefined()
  })

  it('projects native message_end content and retry status without duplicating streamed thinking', () => {
    const [turn] = timelineItems(undefined, [{
      events: [
        runtime(1, { assistantMessageEvent: { delta: 'checking', type: 'thinking_delta' }, type: 'message_update' }),
        runtime(2, { message: { content: [{ thinking: 'checking', type: 'thinking' }, { arguments: { command: 'pnpm test' }, id: 'call-1', name: 'bash', type: 'toolCall' }], role: 'assistant' }, type: 'message_end' }),
        runtime(3, { toolCallId: 'call-1', toolName: 'bash', type: 'tool_execution_start' }),
        runtime(4, { type: 'auto_retry_start' }),
      ],
      id: 'native-plan',
      prompt: 'Implement the plan.',
      startedAt: '2026-09-29T08:41:14.593Z',
    }], [])

    expect(turn?.parts.map((part) => part.kind)).toEqual(['thinking', 'tool', 'retry'])
    expect(turn?.parts[0]).toMatchObject({ text: 'checking' })
  })

  it('does not turn unowned session metadata into a chat row', () => {
    expect(timelineItems(undefined, [], [runtime(1, { type: 'model_change' }, undefined)])).toEqual([])
  })

  it('keeps persisted turns while adding only the explicitly submitted live user turn', () => {
    const history = [
      { id: 'user-1', parentId: null, raw: { message: { content: 'old one', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'message' },
      { id: 'user-2', parentId: 'user-1', raw: { message: { content: 'old two', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:01:00.000Z', type: 'message' },
    ]
    const items = timelineItems(history, [{
      events: [runtime(1, { type: 'message_update', assistantMessageEvent: { delta: 'live', type: 'text_delta' } }, 'runtime-turn-a')],
      historyTurnCount: 2,
      id: 'pending:session-1',
      prompt: 'new prompt',
      startedAt: '2026-09-22T00:02:00.000Z',
    }, {
      events: [runtime(2, { type: 'tool_execution_start' }, 'runtime-turn-b')],
      id: 'runtime-only',
      startedAt: '2026-09-22T00:02:01.000Z',
    }], [])

    expect(items.map((item) => item.id)).toEqual(['user-1', 'user-2', 'pending:session-1'])
    expect(items.at(-1)).toMatchObject({ prompt: 'new prompt' })
  })

  it('keeps the runtime start timestamp stable while streaming events update', () => {
    const live = { events: [runtime(1, { type: 'message_update' })], id: 'pending:session-1', prompt: 'new', startedAt: '2026-09-22T00:01:00.000Z' }

    const initial = timelineItems(undefined, [live], [])
    const streamed = timelineItems(undefined, [{ ...live, events: [...live.events, runtime(2, { type: 'message_update' })] }], [])

    expect(initial[0]?.runtimeTiming).toEqual({ startedAt: '2026-09-22T00:01:00.000Z' })
    expect(streamed[0]?.runtimeTiming).toEqual(initial[0]?.runtimeTiming)
  })

  it('reuses historical projections and navigation while the latest Turn streams', () => {
    const history = [{ id: 'user-1', parentId: null, raw: { message: { content: 'old', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'message' }]
    const initialTurns = [{ events: [runtime(1, { type: 'message_update', assistantMessageEvent: { delta: 'one', type: 'text_delta' } }, 'live')], historyTurnCount: 1, id: 'live', prompt: 'new', startedAt: '2026-09-22T00:01:00.000Z' }]
    const initial = timelineItems(history, initialTurns, [])
    const navigation = timelineNavigationEntries(initial)
    const streamed = timelineItems(history, [{ ...initialTurns[0]!, events: [...initialTurns[0]!.events, runtime(2, { type: 'message_update', assistantMessageEvent: { delta: ' two', type: 'text_delta' } }, 'live')] }], [])

    expect(timelineItems(history, initialTurns, [])).toBe(initial)
    expect(streamed[0]).toBe(initial[0])
    expect(timelineNavigationEntries(streamed)).toBe(navigation)
  })

  it('retains completion timing when history contains only the submitted user', () => {
    const items = timelineItems([
      { id: 'user-1', parentId: null, raw: { message: { content: 'old', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'message' },
      { id: 'user-2', parentId: 'user-1', raw: { message: { content: 'new', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:01:00.000Z', type: 'message' },
    ], [{ completedAt: '2026-09-22T00:01:26.000Z', events: [runtime(1, { type: 'message_update' })], historyTurnCount: 1, id: 'pending:session-1', prompt: 'new', startedAt: '2026-09-22T00:01:00.000Z' }], [])

    expect(items.map((item) => item.id)).toEqual(['user-1', 'user-2'])
    expect(items[1]).toMatchObject({ startedAt: '2026-09-22T00:01:00.000Z' })
    expect(items[1]?.runtimeTiming?.completedAt).toBe('2026-09-22T00:01:26.000Z')
  })

  it('reconciles the latest runtime Turn when a paged history omits earlier Turns', () => {
    const items = timelineItems([
      { id: 'user-41', parentId: null, raw: { message: { content: 'new', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:01:00.000Z', type: 'message' },
    ], [{ events: [], historyTurnCount: 40, id: 'pending:session-1', prompt: 'new', startedAt: '2026-09-22T00:01:00.000Z' }], [])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'user-41' })
    expect(items[0]?.runtimeTiming?.startedAt).toBe('2026-09-22T00:01:00.000Z')
  })

  it('keeps full user text for the history panel while deriving a bounded navigation label', () => {
    const items = timelineItems(undefined, [{
      events: [],
      id: 'turn-1',
      prompt: `  first line\n${'x'.repeat(120)} `,
      startedAt: '2026-09-22T00:00:00.000Z',
    }], [])

    expect(timelineNavigationEntries(items)).toEqual([
      expect.objectContaining({ id: 'turn-1', index: 1, prompt: `  first line\n${'x'.repeat(120)} `, promptPreview: 'first line' }),
    ])
  })

  it('does not turn a runtime-only blank prompt into a navigation node', () => {
    expect(timelineItems(undefined, [{ events: [], id: 'turn-1', prompt: ' '.repeat(120), startedAt: '2026-09-22T00:00:00.000Z' }], [])).toEqual([])
  })
})

describe('live history reconciliation', () => {
  const entry = (id: string, role: string, content: unknown, timestamp = '2026-09-22T00:00:00.000Z') => ({ id, parentId: null, raw: { type: 'message', message: { role, content } }, timestamp, type: 'message' })
  const live = (events: ReturnType<typeof runtime>[], completedAt?: string) => ({ id: 'live', prompt: 'go', startedAt: '2026-09-22T00:00:00.000Z', events, ...(completedAt ? { completedAt } : {}) })

  it('renders thinking and tools before settlement despite user-only or partial assistant history', () => {
    const events = [runtime(1, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'checking' } }), runtime(2, { type: 'tool_execution_start', toolCallId: 'call', toolName: 'read' })]
    const history = [entry('user', 'user', 'go')]
    const before = timelineItems(undefined, [live(events)], [])[0]!
    const userOnly = timelineItems(history, [live(events)], [])[0]!
    const partial = timelineItems([...history, entry('assistant', 'assistant', [{ type: 'thinking', thinking: 'check' }])], [live(events)], [])[0]!
    expect(userOnly.parts.map((part) => part.kind)).toEqual(['thinking', 'tool'])
    expect(partial.parts).toEqual(userOnly.parts)
    expect(userOnly.displayId).toBe(before.displayId)
    expect(timelineItems(history, [], [])[0]?.parts).toEqual([])
  })

  it('keeps the completed live answer until history covers it and keeps its display key on takeover', () => {
    const events = [runtime(1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } })]
    const turns = [live(events, '2026-09-22T00:00:02.000Z')]
    const history = [entry('user', 'user', 'go')]
    const incomplete = timelineItems(history, turns, [])[0]!
    const complete = timelineItems([...history, entry('assistant', 'assistant', [{ type: 'text', text: 'answer' }])], turns, [])[0]!
    expect(incomplete.parts[0]).toMatchObject({ text: 'answer' })
    expect(incomplete.runtimeTiming).toBeDefined()
    expect(complete.runtimeTiming).toBeUndefined()
    expect(complete.displayId).toBe(incomplete.displayId)
  })

  it('uses the submission anchor for identical prompts even when pagination shifts their positions', () => {
    const history = [entry('older', 'user', 'go', '2026-09-21T00:00:00.000Z'), entry('anchor', 'user', 'go', '2026-09-21T01:00:00.000Z'), entry('new', 'user', 'go')]
    const turns = [{ ...live([runtime(1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'new answer' } })]), historyAnchorId: 'anchor', historyTurnCount: 1 }]
    expect(timelineItems(history, turns, []).map((item) => item.id)).toEqual(['older', 'anchor', 'new'])
    expect(timelineItems(history.slice(1), turns, []).at(-1)?.parts[0]).toMatchObject({ text: 'new answer' })
  })

  it('appends repeated delta tokens and replaces only their own message block snapshots', () => {
    const events = [
      runtime(1, { type: 'message_start', message: { role: 'assistant' } }),
      runtime(2, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'a' } }),
      runtime(3, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'a' } }),
      runtime(4, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'aa' }] } }),
      runtime(5, { type: 'message_start', message: { role: 'assistant' } }),
      runtime(6, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'aa' } }),
      runtime(7, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'aa' }] } }),
    ]
    const item = timelineItems(undefined, [live(events)], [])[0]!
    expect(item.parts.map((part) => 'text' in part ? part.text : '')).toEqual(['aa', 'aa'])
    expect(item.runtimeTiming?.completedAt).toBeUndefined()
  })
})

it('keeps a submitted turn key stable at execution start and gives the next submission a new key', () => {
  const submitted = { id: 'pending:session', prompt: 'go', events: [], submittedAt: '2026-09-22T00:00:00.000Z', startedAt: '2026-09-22T00:00:00.000Z' }
  const first = timelineItems(undefined, [submitted], [])[0]!
  const running = timelineItems(undefined, [{ ...submitted, startedAt: '2026-09-22T00:00:05.000Z' }], [])[0]!
  const next = timelineItems(undefined, [{ ...submitted, submittedAt: '2026-09-22T00:01:00.000Z' }], [])[0]!
  expect(running.displayId).toBe(first.displayId)
  expect(next.displayId).not.toBe(first.displayId)
})

it('retains partial output and deduplicates a model error across live events and persisted history', () => {
  const message = { role: 'assistant', stopReason: 'error', errorMessage: '403: 您无权访问glm-5.3-highspeed。', provider: 'zai-coding-cn', model: 'glm-5.3-highspeed', content: [] }
  const turns = [{ id: 'turn-1', prompt: 'go', startedAt: '2026-09-22T00:00:00.000Z', completedAt: '2026-09-22T00:00:03.000Z', events: [
    runtime(1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }),
    runtime(2, { type: 'message_end', message }),
    runtime(3, { type: 'message_end', message }),
  ] }]
  const live = timelineItems(undefined, turns, [])[0]!
  expect(live.modelErrors).toHaveLength(1)
  expect(live.parts[0]).toMatchObject({ kind: 'assistant_text', text: 'partial' })
  const history = [
    { id: 'u1', parentId: null, timestamp: turns[0]!.startedAt, type: 'message', raw: { type: 'message', message: { role: 'user', content: 'go' } } },
    { id: 'a1', parentId: 'u1', timestamp: '2026-09-22T00:00:03.000Z', type: 'message', raw: { type: 'message', message } },
  ]
  expect(timelineItems(history, [], [])[0]?.modelErrors).toEqual(live.modelErrors)
  expect(timelineItems(history, turns, [])[0]?.modelErrors).toHaveLength(1)
  expect(timelineItems(undefined, [{ ...turns[0]!, events: [] }], [])[0]?.modelErrors).toBeUndefined()
})

it('does not let a stale history response erase a live error after partial output', () => {
  const history = [
    { id: 'u1', parentId: null, timestamp: '2026-09-22T00:00:00.000Z', type: 'message', raw: { type: 'message', message: { role: 'user', content: 'go' } } },
    { id: 'a1', parentId: 'u1', timestamp: '2026-09-22T00:00:01.000Z', type: 'message', raw: { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } } },
  ]
  const turns = [{ id: 'turn-1', prompt: 'go', startedAt: history[0]!.timestamp, completedAt: '2026-09-22T00:00:03.000Z', events: [
    runtime(1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }),
    runtime(2, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '403: denied', content: [] } }),
  ] }]
  expect(timelineItems(history, turns, [])[0]?.modelErrors).toHaveLength(1)
})

it('shows confirmed plan completion data once and prefers it to legacy presentation', () => {
  const details = { version: 1, source: 'plan_mode_complete', plan: '# Confirmed plan\n\n1. Research\n2. Report' }
  const events = [
    runtime(1, { type: 'custom_message', customType: 'proposed-plan', display: true, content: 'Legacy plan' }),
    runtime(2, { type: 'tool_execution_end', toolCallId: 'complete', result: { details } }),
    runtime(3, { type: 'message', message: { role: 'toolResult', toolName: 'plan_mode_complete', toolCallId: 'complete', details } }),
    runtime(4, { type: 'custom_message', customType: 'proposed-plan', display: true, content: 'Repeated legacy plan' }),
  ]
  const turn = { id: 'live', prompt: 'research', startedAt: events[0]!.observedAt, events }
  const projected = timelineItems(undefined, [turn], [])[0]!
  expect(projected.plan).toEqual({ text: details.plan, id: 'complete', source: 'completion' })
  expect(projected.parts.filter((part) => part.kind === 'assistant_text')).toHaveLength(0)
  const failed = timelineItems(undefined, [{ ...turn, events: [runtime(2, { type: 'tool_execution_end', isError: true, result: { details } })] }], [])[0]!
  expect(failed.plan).toBeUndefined()
})

it('matches a stripped native plan prompt to history rather than adding a duplicate round', () => {
  const entries = [
    { id: 'user', parentId: null, type: 'message', timestamp: '2026-09-22T00:00:00.000Z', raw: { type: 'message', message: { role: 'user', content: 'research' } } },
    { id: 'answer', parentId: 'user', type: 'message', timestamp: '2026-09-22T00:00:03.000Z', raw: { type: 'message', message: { role: 'assistant', content: 'Planning summary' } } },
  ]
  const turns = [{ id: 'pending', prompt: '/plan research', startedAt: entries[0]!.timestamp, events: [runtime(1, { type: 'message_start', message: { role: 'user', content: 'research' } })] }]
  expect(timelineItems(entries, turns, [])).toHaveLength(1)
})
