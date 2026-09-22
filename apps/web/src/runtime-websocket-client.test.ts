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

    const attach = client.attach('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'attach' }))
    socket.receive({ command: 'attach', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await attach

    const attachSecond = client.attach('session-b')
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-2', resume: { after: 0 }, sessionId: 'session-b', type: 'attach' }))
    socket.receive({ command: 'attach', id: 'web-2', sessionId: 'session-b', type: 'ack' })
    await attachSecond

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

    const attach = client.attach('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    first.open()
    await vi.waitFor(() => expect(first.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'attach' }))
    first.receive({ command: 'attach', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await attach
    first.receive({ event: { type: 'one' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })
    first.close()

    await new Promise((resolve) => setTimeout(resolve, 10))
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2))
    second.open()
    await vi.waitFor(() => expect(second.sent).toContainEqual({ id: 'web-2', resume: { after: 1 }, sessionId: 'session-a', type: 'attach' }))
    second.receive({ command: 'attach', id: 'web-2', sessionId: 'session-a', type: 'ack' })
    second.receive({ event: { type: 'one' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })
    second.receive({ event: { type: 'two' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', type: 'pi_event' })
    expect(sequences).toEqual([1, 2])
    vi.unstubAllGlobals()
  })

  it('keeps delivering live events after attach repeats for the same session', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))),
      socketFactory,
    })
    const sequences: number[] = []
    client.onPiEvent((event) => sequences.push(event.sequence))

    const attach = client.attach('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'attach' }))
    socket.receive({ command: 'attach', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await attach
    socket.receive({ event: { type: 'one' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })

    // The run controller re-attaches before every prompt even though the stream is already consumed.
    const repeated = client.attach('session-a')
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-2', resume: { after: 0 }, sessionId: 'session-a', type: 'attach' }))
    socket.receive({ command: 'attach', id: 'web-2', sessionId: 'session-a', type: 'ack' })
    await repeated
    socket.receive({ event: { type: 'two' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', type: 'pi_event' })

    expect(sequences).toEqual([1, 2])
    expect(socket.sent.filter((message) => message.type === 'attach')).toHaveLength(2)
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
    const attach = client.attach('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'attach' }))
    socket.receive({ command: 'attach', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await attach

    socket.receive({ event: { type: 'two' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', type: 'pi_event' })
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-2', resume: { after: 0 }, sessionId: 'session-a', type: 'attach' }))
    socket.receive({ command: 'attach', id: 'web-2', sessionId: 'session-a', type: 'ack' })
    socket.receive({ event: { type: 'one' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', type: 'pi_event' })
    socket.receive({ event: { type: 'two' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', type: 'pi_event' })
    expect(sequences).toEqual([1, 2])
    vi.unstubAllGlobals()
  })
})
