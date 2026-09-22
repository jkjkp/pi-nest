import { describe, expect, it } from 'vitest'

import { timelineItems } from './timeline-model.js'

const runtime = (sequence: number, event: Record<string, unknown>, turnId = 'turn-1') => ({ event, observedAt: `2026-09-22T00:00:0${sequence}.000Z`, sequence, sessionId: 'session-1', turnId })

describe('timelineItems', () => {
  it('keeps runtime events in sequence order and progressively classifies known Pi events', () => {
    const items = timelineItems(undefined, [{
      events: [
        runtime(1, { type: 'message_update', assistantMessageEvent: { delta: 'Hello', type: 'text_delta' } }),
        runtime(2, { type: 'message_update', assistantMessageEvent: { delta: 'reasoning', type: 'thinking_delta' } }),
        runtime(3, { toolCallId: 'call-1', toolName: 'bash', type: 'tool_execution_start' }),
        runtime(4, { partialResult: 'ok', toolCallId: 'call-1', toolName: 'bash', type: 'tool_execution_update' }),
        runtime(5, { isError: false, toolCallId: 'call-1', toolName: 'bash', type: 'tool_execution_end' }),
        runtime(6, { command: 'pwd', cwd: '/fixture', stderr: '', stdout: '/fixture', type: 'bash_execution_update' }),
        runtime(7, { changes: [{ added: 2, path: 'a.ts', removed: 1 }], type: 'file_changes' }),
        runtime(8, { nested: { retained: true }, type: 'future_pi_event' }),
      ],
      id: 'turn-1',
      prompt: 'go',
      startedAt: '2026-09-22T00:00:00.000Z',
    }], [runtime(9, { model: 'next', type: 'model_change' }, undefined)])

    expect(items.map((item) => item.kind)).toEqual(['turn', 'system'])
    const turn = items[0]
    expect(turn).toMatchObject({ kind: 'turn', prompt: 'go' })
    if (turn?.kind !== 'turn') throw new Error('Expected turn')
    expect(turn.parts.map((part) => part.kind)).toEqual(['assistant_text', 'thinking', 'tool', 'bash', 'file_change', 'native'])
    expect(turn.parts.at(-1)?.events[0]?.raw).toEqual({ nested: { retained: true }, type: 'future_pi_event' })
  })

  it('derives historical turns without dropping unknown raw entries', () => {
    const items = timelineItems([
      { id: 'model-1', parentId: null, raw: { id: 'model-1', provider: 'pi', type: 'model_change' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'model_change' },
      { id: 'user-1', parentId: null, raw: { id: 'user-1', message: { content: 'question', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:01.000Z', type: 'message' },
      { id: 'unknown-1', parentId: 'user-1', raw: { id: 'unknown-1', payload: { all: 'retained' }, type: 'new_entry' }, timestamp: '2026-09-22T00:00:02.000Z', type: 'new_entry' },
      { id: 'assistant-1', parentId: 'user-1', raw: { id: 'assistant-1', message: { content: [{ text: 'answer', type: 'text' }], role: 'assistant' }, type: 'message' }, timestamp: '2026-09-22T00:00:03.000Z', type: 'message' },
    ], [], [])

    expect(items.map((item) => item.kind)).toEqual(['system', 'turn'])
    const turn = items[1]
    if (turn?.kind !== 'turn') throw new Error('Expected turn')
    expect(turn.prompt).toBe('question')
    expect(turn.parts.map((part) => part.kind)).toEqual(['native', 'assistant_text'])
    expect(turn.parts[0]?.events[0]?.raw).toEqual({ id: 'unknown-1', payload: { all: 'retained' }, type: 'new_entry' })
  })
})
