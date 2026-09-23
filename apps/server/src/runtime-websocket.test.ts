import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RuntimeWebSocketBroker } from './runtime-websocket.js'
import { PiRuntimeCapacityError, PiRuntimeRegistry } from './pi-runtime-registry.js'

const adapter = vi.hoisted(() => ({ listPiSessions: vi.fn() }))
vi.mock('@pi-nest/pi-adapter', () => adapter)

const nativeSession = { cwd: '/fixture', id: 'session-1', sessionFile: '/fixture/session.jsonl' }

function socket() {
  const sent: unknown[] = []
  return { send: vi.fn((value: string) => sent.push(JSON.parse(value))), sent }
}

function runtime() {
  const subscribers = new Map<string, Set<(event: any) => void>>()
  return {
    abort: vi.fn().mockResolvedValue(true),
    commandWhenIdle: vi.fn().mockResolvedValue({ data: { levels: ['low', 'high'], models: [{ id: 'model-2', name: 'Model 2', provider: 'test' }] } }),
    commandWhileRunning: vi.fn().mockResolvedValue({ success: true }),
    respondToExtension: vi.fn().mockResolvedValue(true),
    startPrompt: vi.fn().mockReturnValue(Promise.resolve({ stopReason: 'stop' })),
    resume: vi.fn().mockResolvedValue(undefined),
    unwatch: vi.fn().mockReturnValue(true),
    watch: vi.fn(async (sessionId: string, _subscriberId: string, _after: number, listener: (event: any) => void, _onError?: unknown, _snapshot?: (value: unknown) => void, _status?: (value: unknown) => void) => {
      const listeners = subscribers.get(sessionId) ?? new Set()
      listeners.add(listener)
      subscribers.set(sessionId, listeners)
      return () => { listeners.delete(listener) }
    }),
    emit: (event: any) => { for (const listener of subscribers.get(event.sessionId) ?? []) listener(event) },
  }
}

describe('RuntimeWebSocketBroker', () => {
  beforeEach(() => {
    adapter.listPiSessions.mockReset()
    adapter.listPiSessions.mockResolvedValue([nativeSession])
  })

  it('requires watch, acknowledges commands, and sends complete unknown Pi events unchanged', async () => {
    const registry = runtime()
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'p1', message: 'hello', sessionId: 'session-1', type: 'prompt' }))
    expect(client.sent).toContainEqual({ code: 'SESSION_NOT_WATCHED', id: 'p1', message: 'Pi session is not watched', sessionId: 'session-1', type: 'error' })

    await broker.message(client, JSON.stringify({ id: 'a1', resume: { after: 0 }, sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'p2', message: 'hello', sessionId: 'session-1', type: 'prompt' }))
    expect(client.sent).toContainEqual({ command: 'watch', id: 'a1', sessionId: 'session-1', type: 'ack' })
    expect(client.sent).toContainEqual({ command: 'prompt', id: 'p2', sessionId: 'session-1', type: 'ack' })
    expect(registry.startPrompt).toHaveBeenCalledWith(nativeSession, 'hello')

    const unknown = { type: 'future_pi_event', value: { retained: true } }
    registry.emit({ event: unknown, observedAt: 'now', sequence: 7, sessionId: 'session-1' })
    expect(client.sent).toContainEqual({ event: unknown, observedAt: 'now', sequence: 7, sessionId: 'session-1', type: 'pi_event' })
  })

  it('allows a connection to watch multiple sessions and disconnects without aborting Pi', async () => {
    const registry = runtime()
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    adapter.listPiSessions.mockResolvedValue([{ ...nativeSession }, { ...nativeSession, id: 'session-2' }])
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'a1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'a2', sessionId: 'session-2', type: 'watch' }))
    expect(registry.watch).toHaveBeenCalledTimes(2)
    broker.close(client)
    expect(registry.unwatch).toHaveBeenCalledTimes(2)
    expect(registry.abort).not.toHaveBeenCalled()
  })

  it('makes unwatch idempotent for one socket', async () => {
    const registry = runtime()
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'w1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'u1', sessionId: 'session-1', type: 'unwatch' }))
    await broker.message(client, JSON.stringify({ id: 'u2', sessionId: 'session-1', type: 'unwatch' }))

    expect(registry.unwatch).toHaveBeenCalledOnce()
    expect(client.sent).toContainEqual({ command: 'unwatch', data: { status: 'unwatched' }, id: 'u1', sessionId: 'session-1', type: 'ack' })
    expect(client.sent).toContainEqual({ command: 'unwatch', data: { status: 'notWatching' }, id: 'u2', sessionId: 'session-1', type: 'ack' })
  })

  it('returns capacity exhaustion before accepting a direct prompt', async () => {
    const registry = runtime()
    registry.resume.mockRejectedValueOnce(new PiRuntimeCapacityError())
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'w1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'p1', message: 'hello', sessionId: 'session-1', type: 'prompt' }))

    expect(client.sent).toContainEqual({ code: 'RUNTIME_CAPACITY_EXCEEDED', id: 'p1', message: 'Pi runtime capacity is exhausted', sessionId: 'session-1', type: 'error' })
    expect(registry.startPrompt).not.toHaveBeenCalled()
  })

  it('replaces a subscription when watch resumes after a newer sequence', async () => {
    const registry = runtime()
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'a1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'a2', resume: { after: 7 }, sessionId: 'session-1', type: 'watch' }))

    expect(registry.watch).toHaveBeenNthCalledWith(1, 'session-1', expect.any(String), 0, expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function))
    expect(registry.watch).toHaveBeenNthCalledWith(2, 'session-1', expect.any(String), 7, expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function))
    expect(client.sent).toContainEqual({ command: 'watch', id: 'a2', sessionId: 'session-1', type: 'ack' })
  })

  it('resubscribes when watch repeats with the same cursor so replays stay possible', async () => {
    const registry = runtime()
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'a1', resume: { after: 0 }, sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'a2', resume: { after: 0 }, sessionId: 'session-1', type: 'watch' }))

    expect(registry.watch).toHaveBeenCalledTimes(2)
    expect(client.sent).toContainEqual({ command: 'watch', id: 'a2', sessionId: 'session-1', type: 'ack' })
  })

  it('sends a coherent snapshot before raw replay and the watch acknowledgement', async () => {
    const registry = runtime()
    registry.watch.mockImplementationOnce(async (_sessionId: string, _subscriberId: string, _after: number, listener: (event: any) => void, _onError: unknown, snapshot?: (value: unknown) => void) => {
      snapshot?.({
        atSequence: 7,
        extensionUi: { freshness: 'known', statuses: { agent: 'thinking' }, widgets: { todo: ['one'] } },
        runtime: { lifecycle: 'active', revision: 3 },
        sessionId: 'session-1',
      })
      listener({ event: { method: 'setStatus', type: 'extension_ui_request' }, observedAt: 'before', sequence: 7, sessionId: 'session-1' })
      listener({ event: { type: 'turn_start' }, observedAt: 'after', sequence: 8, sessionId: 'session-1' })
      return () => undefined
    })
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'a1', resume: { after: 0 }, sessionId: 'session-1', type: 'watch' }))
    expect(client.sent.map((message) => (message as { type: string }).type)).toEqual(['session_snapshot', 'pi_event', 'pi_event', 'ack'])
    expect(client.sent[0]).toMatchObject({ atSequence: 7, sessionId: 'session-1', type: 'session_snapshot' })
  })

  it('requires a resync before replaying an impossible cursor', async () => {
    const registry = new PiRuntimeRegistry()
    const broker = new RuntimeWebSocketBroker(registry)
    const client = socket()
    broker.open(client)
    await broker.message(client, JSON.stringify({ id: 'a1', resume: { after: 1 }, sessionId: 'session-1', type: 'watch' }))
    expect(client.sent.map((message) => (message as { type: string }).type)).toEqual(['resync_required', 'session_snapshot', 'ack'])
    expect(client.sent[0]).toEqual({ reason: 'sequence_gap', sessionId: 'session-1', type: 'resync_required' })
    await registry.close()
  })

  it('rejects malformed commands without exposing native state', async () => {
    const broker = new RuntimeWebSocketBroker(runtime() as never)
    const client = socket()
    broker.open(client)
    await broker.message(client, '{bad json')
    expect(client.sent).toEqual([{ code: 'INVALID_COMMAND', message: 'WebSocket command must be valid JSON', type: 'error' }])
  })

  it('forwards advanced controls only after explicit resume and keeps returned data safe', async () => {
    const registry = runtime()
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    broker.open(client)
    await broker.message(client, JSON.stringify({ id: 's1', message: 'focus on tests', sessionId: 'session-1', type: 'steer' }))
    expect(client.sent).toContainEqual({ code: 'SESSION_NOT_WATCHED', id: 's1', message: 'Pi session is not watched', sessionId: 'session-1', type: 'error' })
    await broker.message(client, JSON.stringify({ id: 'a1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'r1', sessionId: 'session-1', type: 'resume' }))
    await broker.message(client, JSON.stringify({ id: 'm1', sessionId: 'session-1', type: 'get_available_models' }))
    await broker.message(client, JSON.stringify({ id: 'u1', dialogId: 'dialog-1', sessionId: 'session-1', type: 'extension_ui_response', value: 'yes' }))
    expect(registry.commandWhenIdle).toHaveBeenCalledWith(nativeSession, { type: 'get_available_models' })
    expect(registry.respondToExtension).toHaveBeenCalledWith('session-1', { id: 'dialog-1', type: 'extension_ui_response', value: 'yes' })
    expect(client.sent).toContainEqual({ command: 'get_available_models', data: { models: [{ id: 'model-2', name: 'Model 2', provider: 'test' }] }, id: 'm1', sessionId: 'session-1', type: 'ack' })
  })
})
