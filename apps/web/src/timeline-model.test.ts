import { describe, expect, it } from 'vitest'

import { diagnosticLabel, timelineItems, timelineNavigationEntries } from './timeline-model.js'

const runtime = (sequence: number, event: Record<string, unknown>, turnId = 'turn-1') => ({ event, observedAt: `2026-09-22T00:00:${String(sequence).padStart(2, '0')}.000Z`, sequence, sessionId: 'session-1', turnId })

describe('timelineItems', () => {
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
    ], [], [])

    expect(turn).toMatchObject({ kind: 'turn', prompt: 'question' })
    expect(turn?.parts.map((part) => part.kind)).toEqual(['assistant_text'])
    expect(turn?.diagnostics.map(diagnosticLabel)).toEqual(['未识别的 Pi 事件：custom', '运行元数据：agent_settled'])
    expect(turn?.events.map((event) => event.id)).toEqual(['user-1', 'unknown-1', 'assistant-1', 'end-1'])
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

  it('drops the provisional live turn once its persisted user entry is present', () => {
    const items = timelineItems([
      { id: 'user-1', parentId: null, raw: { message: { content: 'old', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'message' },
      { id: 'user-2', parentId: 'user-1', raw: { message: { content: 'new', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:01:00.000Z', type: 'message' },
    ], [{ events: [runtime(1, { type: 'message_update' })], historyTurnCount: 1, id: 'pending:session-1', prompt: 'new', startedAt: '2026-09-22T00:01:00.000Z' }], [])

    expect(items.map((item) => item.id)).toEqual(['user-1', 'user-2'])
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
