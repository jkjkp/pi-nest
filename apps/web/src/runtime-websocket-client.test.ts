import { describe, expect, it, vi } from 'vitest'

import { RuntimeWebSocketClient } from './runtime-websocket-client.js'

class FakeSocket {
  readyState = 0
  readonly sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<string, Array<(event: any) => void>>()

  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close() { this.readyState = 3; this.emit('close', {}) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  emit(type: string, event: any) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  open() { this.readyState = 1; this.emit('open', {}) }
  receive(message: unknown) { this.emit('message', { data: JSON.stringify(message) }) }
}

describe('RuntimeWebSocketClient', () => {
  it('uses one connection for multiple commands and dispatches raw Pi events', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' })))),
      socketFactory,
    })
    const events: unknown[] = []
    client.onPiEvent((event) => events.push(event))

    const watch = client.watch('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await watch

    const watchSecond = client.watch('session-b')
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-2', resume: { after: 0 }, sessionId: 'session-b', type: 'watch' }))
    socket.receive({ command: 'watch', id: 'web-2', sessionId: 'session-b', type: 'ack' })
    await watchSecond

    const prompt = client.prompt('session-b', 'hello')
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-3', message: 'hello', sessionId: 'session-b', type: 'prompt' }))
    socket.receive({ command: 'prompt', id: 'web-3', sessionId: 'session-b', type: 'ack' })
    await prompt
    socket.receive({ event: { type: 'future_pi_event' }, observedAt: 'now', sequence: 1, sessionId: 'session-b', type: 'pi_event' })
    expect(events).toEqual([{ event: { type: 'future_pi_event' }, observedAt: 'now', sequence: 1, sessionId: 'session-b' }])
    vi.unstubAllGlobals()
  })

  it('reconnects with the last delivered sequence and ignores duplicate replay events', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const first = new FakeSocket()
    const second = new FakeSocket()
    const socketFactory = vi.fn().mockReturnValueOnce(first as never).mockReturnValueOnce(second as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' })))),
      reconnectDelay: () => 0,
      socketFactory,
    })
    const sequences: number[] = []
    client.onPiEvent((event) => sequences.push(event.sequence))

    const watch = client.watch('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    first.open()
    await vi.waitFor(() => expect(first.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
    first.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await watch
    first.receive({ event: { type: 'one' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })
    first.close()

    await new Promise((resolve) => setTimeout(resolve, 10))
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2))
    second.open()
    await vi.waitFor(() => expect(second.sent).toContainEqual({ id: 'web-2', resume: { after: 1 }, sessionId: 'session-a', type: 'watch' }))
    second.receive({ command: 'watch', id: 'web-2', sessionId: 'session-a', type: 'ack' })
    second.receive({ event: { type: 'one' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })
    second.receive({ event: { type: 'two' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', type: 'pi_event' })
    expect(sequences).toEqual([1, 2])
    vi.unstubAllGlobals()
  })

  it('keeps delivering live events after watch repeats for the same session', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))),
      socketFactory,
    })
    const sequences: number[] = []
    client.onPiEvent((event) => sequences.push(event.sequence))

    const watch = client.watch('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await watch
    socket.receive({ event: { type: 'one' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })

    const repeated = client.watch('session-a')
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-2', resume: { after: 1 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({ command: 'watch', id: 'web-2', sessionId: 'session-a', type: 'ack' })
    await repeated
    socket.receive({ event: { type: 'two' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', type: 'pi_event' })

    expect(sequences).toEqual([1, 2])
    expect(socket.sent.filter((message) => message.type === 'watch')).toHaveLength(2)
    vi.unstubAllGlobals()
  })

  it('does not render an out-of-order event before requesting a replay', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))),
      socketFactory,
    })
    const sequences: number[] = []
    client.onPiEvent((event) => sequences.push(event.sequence))
    const watch = client.watch('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await watch

    socket.receive({ event: { type: 'two' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', type: 'pi_event' })
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-2', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({ command: 'watch', id: 'web-2', sessionId: 'session-a', type: 'ack' })
    socket.receive({ event: { type: 'one' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })
    socket.receive({ event: { type: 'two' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', type: 'pi_event' })
    expect(sequences).toEqual([1, 2])
    vi.unstubAllGlobals()
  })

  it('keeps raw replay for turns while protecting a snapshot projection from older UI events', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))),
      socketFactory,
    })
    const snapshots: unknown[] = []
    const statuses: unknown[] = []
    const events: number[] = []
    client.onSessionSnapshot((snapshot) => snapshots.push(snapshot))
    client.onRuntimeStatus((status) => statuses.push(status))
    client.onPiEvent((event) => events.push(event.sequence))
    const watch = client.watch('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({
      atSequence: 3,
      extensionUi: { freshness: 'known', statuses: { agent: 'fresh' }, widgets: { todo: ['one'] } },
      runtime: { lifecycle: 'active', revision: 2 },
      sessionId: 'session-a',
      type: 'session_snapshot',
    })
    socket.receive({ event: { method: 'setStatus', statusKey: 'agent', statusText: 'stale', type: 'extension_ui_request' }, observedAt: 'old', sequence: 1, sessionId: 'session-a', type: 'pi_event' })
    socket.receive({ event: { type: 'turn_start' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', type: 'pi_event' })
    socket.receive({ event: { method: 'setWidget', widgetKey: 'todo', widgetLines: ['freshest'], type: 'extension_ui_request' }, observedAt: 'new', sequence: 3, sessionId: 'session-a', type: 'pi_event' })
    socket.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await watch
    expect(snapshots).toHaveLength(1)
    expect(statuses).toEqual([{ lifecycle: 'active', revision: 2, sessionId: 'session-a' }])
    expect(events).toEqual([1, 2, 3])
    expect(client.shouldApplyExtensionUi({ event: {}, observedAt: 'old', sequence: 3, sessionId: 'session-a' })).toBe(false)
    expect(client.shouldApplyExtensionUi({ event: {}, observedAt: 'new', sequence: 4, sessionId: 'session-a' })).toBe(true)
    vi.unstubAllGlobals()
  })

  it('retains restored projection semantics until a newer live UI update arrives', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))),
      socketFactory,
    })
    const watch = client.watch('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({ atSequence: 0, extensionUi: { freshness: 'restored', statuses: { agent: 'previous' }, widgets: {} }, runtime: { lifecycle: 'notLoaded', revision: 0 }, sessionId: 'session-a', type: 'session_snapshot' })
    socket.receive({ event: { method: 'setStatus', statusKey: 'agent', statusText: 'live', type: 'extension_ui_request' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })
    socket.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await watch
    expect(client.extensionUiFreshness('session-a')).toBe('known')
    vi.unstubAllGlobals()
  })

  it('only applies strictly newer runtime lifecycle revisions', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))),
      socketFactory,
    })
    const states: unknown[] = []
    client.onRuntimeStatus((status) => states.push(status))
    const watch = client.watch('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({ atSequence: 0, extensionUi: { freshness: 'unknown', statuses: {}, widgets: {} }, runtime: { lifecycle: 'idle', revision: 2 }, sessionId: 'session-a', type: 'session_snapshot' })
    socket.receive({ lifecycle: 'active', revision: 2, sessionId: 'session-a', type: 'runtime_status' })
    socket.receive({ lifecycle: 'failed', revision: 3, error: 'broken', sessionId: 'session-a', type: 'runtime_status' })
    socket.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await watch
    expect(states).toEqual([{ lifecycle: 'idle', revision: 2, sessionId: 'session-a' }, { error: 'broken', lifecycle: 'failed', revision: 3, sessionId: 'session-a' }])
    vi.unstubAllGlobals()
  })

  it('clears the replay cursor before applying the snapshot required by a resync', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))),
      socketFactory,
    })
    const resyncs: unknown[] = []
    client.onResyncRequired((message) => resyncs.push(message))
    const watch = client.watch('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await watch
    socket.receive({ event: { type: 'one' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })
    socket.receive({ reason: 'event_buffer_expired', sessionId: 'session-a', type: 'resync_required' })
    socket.receive({ atSequence: 0, extensionUi: { freshness: 'unknown', statuses: {}, widgets: {} }, runtime: { lifecycle: 'notLoaded', revision: 0 }, sessionId: 'session-a', type: 'session_snapshot' })

    expect(resyncs).toEqual([{ reason: 'event_buffer_expired', sessionId: 'session-a', type: 'resync_required' }])
    socket.receive({ event: { type: 'replacement' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })
    expect(client.watchedSessions()).toEqual([{ after: 1, role: 'foreground', sessionId: 'session-a' }])
    vi.unstubAllGlobals()
  })
})
