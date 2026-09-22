import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RuntimeWebSocketBroker } from './runtime-websocket.js'
import { PiRuntimeRegistry } from './pi-runtime-registry.js'

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
    subscribe: vi.fn(async (sessionId: string, _after: number, listener: (event: any) => void) => {
      const listeners = subscribers.get(sessionId) ?? new Set()
      listeners.add(listener)
      subscribers.set(sessionId, listeners)
      return () => listeners.delete(listener)
    }),
    emit: (event: any) => { for (const listener of subscribers.get(event.sessionId) ?? []) listener(event) },
  }
}

describe('RuntimeWebSocketBroker', () => {
  beforeEach(() => {
    adapter.listPiSessions.mockReset()
    adapter.listPiSessions.mockResolvedValue([nativeSession])
  })

  it('requires attach, acknowledges commands, and sends complete unknown Pi events unchanged', async () => {
    const registry = runtime()
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'p1', message: 'hello', sessionId: 'session-1', type: 'prompt' }))
    expect(client.sent).toContainEqual({ code: 'SESSION_NOT_ATTACHED', id: 'p1', message: 'Pi session is not attached', sessionId: 'session-1', type: 'error' })

    await broker.message(client, JSON.stringify({ id: 'a1', resume: { after: 0 }, sessionId: 'session-1', type: 'attach' }))
    await broker.message(client, JSON.stringify({ id: 'p2', message: 'hello', sessionId: 'session-1', type: 'prompt' }))
    expect(client.sent).toContainEqual({ command: 'attach', id: 'a1', sessionId: 'session-1', type: 'ack' })
    expect(client.sent).toContainEqual({ command: 'prompt', id: 'p2', sessionId: 'session-1', type: 'ack' })
    expect(registry.startPrompt).toHaveBeenCalledWith(nativeSession, 'hello')

    const unknown = { type: 'future_pi_event', value: { retained: true } }
    registry.emit({ event: unknown, observedAt: 'now', sequence: 7, sessionId: 'session-1' })
    expect(client.sent).toContainEqual({ event: unknown, observedAt: 'now', sequence: 7, sessionId: 'session-1', type: 'pi_event' })
  })

  it('allows a connection to attach multiple sessions and disconnects without aborting Pi', async () => {
    const registry = runtime()
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    adapter.listPiSessions.mockResolvedValue([{ ...nativeSession }, { ...nativeSession, id: 'session-2' }])
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'a1', sessionId: 'session-1', type: 'attach' }))
    await broker.message(client, JSON.stringify({ id: 'a2', sessionId: 'session-2', type: 'attach' }))
    expect(registry.subscribe).toHaveBeenCalledTimes(2)
    broker.close(client)
    expect(registry.abort).not.toHaveBeenCalled()
  })

  it('replaces a subscription when attach resumes after a newer sequence', async () => {
    const registry = runtime()
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'a1', sessionId: 'session-1', type: 'attach' }))
    await broker.message(client, JSON.stringify({ id: 'a2', resume: { after: 7 }, sessionId: 'session-1', type: 'attach' }))

    expect(registry.subscribe).toHaveBeenNthCalledWith(1, 'session-1', 0, expect.any(Function), expect.any(Function))
    expect(registry.subscribe).toHaveBeenNthCalledWith(2, 'session-1', 7, expect.any(Function), expect.any(Function))
    expect(client.sent).toContainEqual({ command: 'attach', id: 'a2', sessionId: 'session-1', type: 'ack' })
  })

  it('returns a safe error for an impossible replay cursor', async () => {
    const registry = new PiRuntimeRegistry()
    const broker = new RuntimeWebSocketBroker(registry)
    const client = socket()
    broker.open(client)
    await broker.message(client, JSON.stringify({ id: 'a1', resume: { after: 1 }, sessionId: 'session-1', type: 'attach' }))
    expect(client.sent).toEqual([{ code: 'RESUME_AHEAD', id: 'a1', message: 'Pi runtime replay sequence is invalid', sessionId: 'session-1', type: 'error' }])
    await registry.close()
  })

  it('rejects malformed commands without exposing native state', async () => {
    const broker = new RuntimeWebSocketBroker(runtime() as never)
    const client = socket()
    broker.open(client)
    await broker.message(client, '{bad json')
    expect(client.sent).toEqual([{ code: 'INVALID_COMMAND', message: 'WebSocket command must be valid JSON', type: 'error' }])
  })

  it('forwards advanced controls only after attach and keeps returned data safe', async () => {
    const registry = runtime()
    const broker = new RuntimeWebSocketBroker(registry as never)
    const client = socket()
    broker.open(client)
    await broker.message(client, JSON.stringify({ id: 's1', message: 'focus on tests', sessionId: 'session-1', type: 'steer' }))
    expect(client.sent).toContainEqual({ code: 'SESSION_NOT_ATTACHED', id: 's1', message: 'Pi session is not attached', sessionId: 'session-1', type: 'error' })
    await broker.message(client, JSON.stringify({ id: 'a1', sessionId: 'session-1', type: 'attach' }))
    await broker.message(client, JSON.stringify({ id: 'm1', sessionId: 'session-1', type: 'get_available_models' }))
    await broker.message(client, JSON.stringify({ id: 'u1', dialogId: 'dialog-1', sessionId: 'session-1', type: 'extension_ui_response', value: 'yes' }))
    expect(registry.commandWhenIdle).toHaveBeenCalledWith(nativeSession, { type: 'get_available_models' })
    expect(registry.respondToExtension).toHaveBeenCalledWith('session-1', { id: 'dialog-1', type: 'extension_ui_response', value: 'yes' })
    expect(client.sent).toContainEqual({ command: 'get_available_models', data: { models: [{ id: 'model-2', name: 'Model 2', provider: 'test' }] }, id: 'm1', sessionId: 'session-1', type: 'ack' })
  })
})
