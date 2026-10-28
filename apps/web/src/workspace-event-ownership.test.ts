import { beforeEach, expect, it } from 'vitest'
import type { PiRuntimeEvent } from '@pi-nest/contracts'
import type { RuntimeTurn } from './session-run-model.js'
import { useWorkspaceStore } from './workspace-store.js'

const event = (sequence: number, raw: Record<string, unknown>, runId: string | undefined = 'new', turnId = 'native-new'): PiRuntimeEvent => ({ sessionId: 'session', sequence, event: raw, observedAt: '2026-10-28T00:00:00Z', runId, turnId })
const turn = (id: string, runId?: string, events: PiRuntimeEvent[] = []): RuntimeTurn => ({ id, runId, prompt: id, startedAt: '2026-10-28T00:00:00Z', events })
const store = () => useWorkspaceStore.getState()
function seed(turns: RuntimeTurn[]) { store().setRun('session', { status: 'running', turns, systemEvents: [] }) }
const turns = () => store().runs.session!.turns
beforeEach(() => useWorkspaceStore.setState({ runs: {} }))

it.each([
  { type: 'message_update', partial: { role: 'assistant', id: 'reused' } },
  { type: 'message_update', partial: { role: 'assistant', timestamp: 123 } },
  { type: 'tool_execution_end', toolCallId: 'reused' },
])('does not assign reused identities to a previous run: $type', (raw) => {
  const old = { ...turn('old', 'old', [event(1, raw, 'old', 'native-old')]), completedAt: 'done' }
  seed([old, turn('new', 'new')])
  store().appendRunEvent('session', event(2, raw))
  expect(turns()[0]).toBe(old)
  expect(turns()[1]!.events).toHaveLength(1)
})

it('keeps delayed tool results in their original turn within one run', () => {
  seed([turn('first', 'new', [event(1, { type: 'tool_execution_start', toolCallId: 'call' })]), { ...turn('steer', 'new'), steering: { status: 'applied' } }])
  store().appendRunEvent('session', event(2, { type: 'message_end', message: { role: 'toolResult', toolCallId: 'call' } }))
  expect(turns().map((saved) => saved.events.length)).toEqual([2, 0])
})

it('binds first events to the unbound active turn without matching completed unbound turns', () => {
  const raw = { type: 'message_update', partial: { role: 'assistant', timestamp: 123 } }
  const old = { ...turn('old', undefined, [{ ...event(1, raw), runId: undefined }]), completedAt: 'done' }
  seed([old, turn('new')])
  store().appendRunEvent('session', event(2, raw))
  expect(turns()[0]).toBe(old)
  expect(turns()[1]).toMatchObject({ runId: 'new', events: [event(2, raw)] })
})

it('scopes events without run identity to the active run rather than old runs', () => {
  const raw = { type: 'tool_execution_end', toolCallId: 'call' }
  const old = { ...turn('old', 'old', [event(1, raw, 'old')]), completedAt: 'done' }
  seed([old, turn('new', 'new')])
  const incoming = { ...event(2, raw), runId: undefined }
  store().appendRunEvent('session', incoming)
  expect(turns()[0]).toBe(old)
  expect(turns()[1]!.events).toEqual([incoming])
})

it('uses a saved event run identity even when the turn has no explicit runId', () => {
  const raw = { type: 'message_update', partial: { role: 'assistant', id: 'same' } }
  const old = { ...turn('old', undefined, [event(1, raw, 'old')]), completedAt: 'done' }
  seed([old, turn('new')])
  store().appendRunEvent('session', event(2, raw))
  expect(turns()[0]).toBe(old)
  expect(turns()[1]!.events).toHaveLength(1)
})

it('does not confuse a real message id with the same timestamp value', () => {
  seed([turn('first', 'new', [event(1, { type: 'message_start', message: { role: 'assistant', timestamp: 123 } })]), turn('new', 'new')])
  store().appendRunEvent('session', event(2, { type: 'message_update', partial: { role: 'assistant', id: 123 } }))
  expect(turns().map((saved) => saved.events.length)).toEqual([1, 1])
})

it('resolves ambiguous identities by native turn information or falls back to the active turn', () => {
  const raw = { type: 'tool_execution_start', toolCallId: 'same' }
  seed([turn('first', 'new', [event(1, raw, 'new', 'first-native')]), turn('second', 'new', [event(2, raw, 'new', 'second-native')]), turn('active', 'new')])
  store().appendRunEvent('session', event(3, { type: 'tool_execution_end', toolCallId: 'same' }, 'new', 'second-native'))
  store().appendRunEvent('session', event(4, { type: 'tool_execution_end', toolCallId: 'same' }))
  expect(turns().map((saved) => saved.events.length)).toEqual([1, 2, 1])
})

it('rejects mismatched run identities even in the fallback path', () => {
  const current = turn('new', 'new')
  seed([current])
  store().appendRunEvent('session', event(1, { type: 'tool_execution_start' }, 'old'))
  expect(turns()[0]).toBe(current)
  expect(store().runs.session!.systemEvents).toHaveLength(1)
})

it('binds pending steering on its native echo and keeps following output on that turn', () => {
  const old = { ...turn('old', 'old'), completedAt: 'done', steering: { status: 'accepted' as const } }
  seed([old, turn('new'), { ...turn('direction'), steering: { status: 'sending' } }])
  store().appendRunEvent('session', event(1, { type: 'message_start', message: { role: 'user', content: 'direction', timestamp: 1 } }))
  expect(turns()[2]).toMatchObject({ runId: 'new', steering: { status: 'applied' } })
  store().appendRunEvent('session', event(2, { type: 'message_start', message: { role: 'assistant', timestamp: 2 } }))
  expect(turns().map((saved) => saved.events.length)).toEqual([0, 0, 2])
})

it('does not bind an unresolved unbound steering from before the current submission', () => {
  const old = { ...turn('direction'), steering: { status: 'unknown' as const } }
  seed([old, turn('new')])
  store().appendRunEvent('session', event(1, { type: 'message_start', message: { role: 'user', content: 'direction' } }))
  expect(turns()[0]).toBe(old)
  expect(turns().at(-1)).toMatchObject({ runId: 'new', prompt: 'direction' })
})

it('keeps native user echoes on their existing turn during replay', () => {
  seed([turn('prompt', 'new')])
  for (let i = 1; i <= 3; i++) store().appendRunEvent('session', event(i, { type: i === 3 ? 'message_end' : 'message_start', message: { role: 'user', id: 'user', content: 'prompt' } }))
  expect(turns()).toHaveLength(1)
  expect(turns()[0]!.events.map((saved) => saved.sequence)).toEqual([1, 2, 3])
})

it('binds a first native user echo using runId before a native turnId exists', () => {
  seed([turn('prompt')])
  const incoming = { ...event(1, { type: 'message_start', message: { role: 'user', id: 'user', content: 'prompt' } }), turnId: undefined }
  store().appendRunEvent('session', incoming)
  expect(turns()).toHaveLength(1)
  expect(turns()[0]).toMatchObject({ runId: 'new', events: [incoming] })
  expect(store().runs.session!.systemEvents).toEqual([])
})
