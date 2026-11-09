import { expect, it } from 'vitest'
import { readManualCompaction, readSessionRunSignal } from './session-run-event.js'

const read = (event: Record<string, unknown>) => readSessionRunSignal({ sessionId: 'session', sequence: 1, observedAt: '2026-11-09T00:00:00Z', event })

it('reads the complete queue snapshot, preserving IDs and metadata for identical messages', () => {
  const queue = {
    steering: ['same'],
    followUp: ['same', 'same'],
    steeringInputs: [{ id: 'steer', message: 'same' }],
    inputs: [
      { id: 'one', message: 'same', recoveryRequired: true },
      { id: 'two', message: 'same', attachmentIds: ['attachment'] },
    ],
  }
  expect(read(Object.freeze({ type: 'queue_update', ...queue }))).toEqual({ kind: 'queue_snapshot', queue })
  expect(read({ type: 'queue_update', steering: [], followUp: [42] })).toBeUndefined()
})

it('recognizes user echoes and leaves unclassified payloads intact', () => {
  expect(read({ type: 'message_start', message: { role: 'user', content: 'queued' } })).toEqual({ kind: 'input_echo', message: 'queued' })
  const event = Object.freeze({ type: 'future_pi_event', payload: Object.freeze({ retained: true }) })
  expect(read(event)).toBeUndefined()
  expect(event.payload).toEqual({ retained: true })
})

it('distinguishes a start that can adopt a run from activity within a run', () => {
  expect(read({ type: 'agent_start' })).toEqual({ kind: 'run_started' })
  for (const event of [
    { type: 'turn_start' },
    { type: 'message_update' },
    { type: 'tool_execution_update' },
    { type: 'message', message: { role: 'assistant' } },
    { type: 'message', message: { role: 'toolResult' } },
  ]) expect(read(event)).toEqual({ kind: 'execution_activity' })
  expect(read({ type: 'message_start', message: { role: 'assistant' } })).toBeUndefined()
})

it('classifies interactive input separately from extension display requests', () => {
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    expect(read({ type: 'extension_ui_request', method })).toEqual({ kind: 'waiting_for_input' })
  }
  for (const method of ['set_editor_text', 'setStatus', 'setWidget', 'notify', 'future_method']) {
    expect(read({ type: 'extension_ui_request', method })).toBeUndefined()
  }
  expect(read({ type: 'extension_ui_resolved', dialogId: 'dialog' })).toEqual({ kind: 'input_resolved' })
})

it('keeps stop reasons distinct from settlement', () => {
  expect(read({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } })).toEqual({ kind: 'stop_reason_observed', reason: 'error' })
  expect(read({ type: 'message_end', message: { role: 'assistant', stopReason: '' } })).toEqual({ kind: 'stop_reason_observed', reason: '' })
  expect(read({ type: 'message_end', message: { role: 'toolResult', stopReason: 'stop' } })).toBeUndefined()
  expect(read({ type: 'turn_end' })).toBeUndefined()
  expect(read({ type: 'agent_end' })).toBeUndefined()
  expect(read({ type: 'agent_settled', aborted: true })).toEqual({ kind: 'run_settled', aborted: true })
  expect(read({ type: 'agent_settled', aborted: 'true' })).toEqual({ kind: 'run_settled', aborted: false })
})


it('separates extension updates and compaction receipts from ordinary run activity', () => {
  expect(read({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'plan' })).toEqual({
    kind: 'extension_projection', projection: { kind: 'status', key: 'plan', text: undefined },
  })
  expect(read({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'plan', widgetLines: ['line', 42] })).toEqual({
    kind: 'extension_projection', projection: { kind: 'widget', key: 'plan', lines: undefined },
  })
  expect(read({ type: 'auto_compaction_end' })).toEqual({ kind: 'automatic_compaction_finished' })
  const compact = (event: Record<string, unknown>) => readManualCompaction({ sessionId: 'session', sequence: 1, observedAt: 'now', event })
  expect(compact({ type: 'compaction_end', aborted: true })).toBe('aborted')
  expect(compact({ type: 'compaction_end', reason: 'manual', aborted: false, result: {} })).toBe('completed')
  expect(compact({ type: 'compaction_end', reason: 'manual', aborted: false, result: [] })).toBeUndefined()
})
