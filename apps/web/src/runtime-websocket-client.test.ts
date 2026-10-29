import { describe, expect, it, vi } from 'vitest'

import { RuntimeWebSocketClient } from './runtime-websocket-client.js'
import { createSessionRunController } from './session-run-controller.js'
import { useWorkspaceStore } from './workspace-store.js'
import { createStore } from 'zustand/vanilla'
import { createWorkspaceState } from './workspace-store.js'

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

it('replays history without overwriting drafts and still accepts a newer live editor update', async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
  const socket = new FakeSocket()
  const factory = vi.fn(() => socket as never)
  const client = new RuntimeWebSocketClient({
    fetchFn: vi.fn(async () => new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))),
    socketFactory: factory,
  })
  const state = createStore(createWorkspaceState)
  state.getState().setDraft('session-a', '用户新草稿')
  createSessionRunController({ state, invalidateHistory: vi.fn(), runtime: client })
  try {
    const watch = client.watch('session-a')
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    socket.receive({ type: 'session_snapshot', sessionId: 'session-a', atSequence: 3, replayAfter: 0, extensionUi: { freshness: 'known', statuses: {}, widgets: {} }, runtime: { lifecycle: 'active', revision: 1 } })
    socket.receive({ type: 'ack', command: 'watch', id: socket.sent[0]!.id, sessionId: 'session-a' })
    await watch
    for (let sequence = 1; sequence <= 3; sequence++) {
      socket.receive({ type: 'pi_event', sessionId: 'session-a', sequence, observedAt: 'now', event: { type: 'extension_ui_request', method: 'set_editor_text', text: '/compact' } })
    }
    expect(state.getState().drafts['session-a']).toBe('用户新草稿')
    socket.receive({ type: 'pi_event', sessionId: 'session-a', sequence: 4, observedAt: 'now', event: { type: 'extension_ui_request', method: 'set_editor_text', text: '新的扩展内容' } })
    expect(state.getState().drafts['session-a']).toBe('新的扩展内容')
  } finally { vi.unstubAllGlobals() }
})

describe('RuntimeWebSocketClient', () => {
  it('rejects an unsuccessful queue command without failing the current run', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const factory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({ fetchFn: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' })))), socketFactory: factory })
    const errors = vi.fn()
    client.onError(errors)
    const queue = client.followUp('session-a', 'later')
    const rejection = expect(queue).rejects.toMatchObject({ code: 'SESSION_NOT_RUNNING' })
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    socket.receive({ type: 'error', id: socket.sent[0]!.id, sessionId: 'session-a', code: 'SESSION_NOT_RUNNING', message: 'Session ended' })
    await rejection
    expect(errors).not.toHaveBeenCalled()
  })
  it('uses one connection for multiple commands and dispatches raw Pi events', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' })))),
      socketFactory,
    })
    const events: unknown[] = []
    const statuses: unknown[] = []
    client.onRuntimeStatus((status) => statuses.push(status))
    client.onPiEvent((event) => events.push(event))

    const watch = client.watch('session-a')
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await watch
    socket.receive({ type: 'runtime_status', sessionId: 'session-a', lifecycle: 'idle', revision: 1, completedRun: { runId: 'run-1', stopReason: 'stop' } })
    expect(statuses.at(-1)).toMatchObject({ completedRun: { runId: 'run-1', stopReason: 'stop' } })

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
    const commands = client.getCommands('session-b')
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-4', type: 'get_commands', sessionId: 'session-b' }))
    socket.receive({ command: 'get_commands', id: 'web-4', sessionId: 'session-b', type: 'ack', data: { commands: [{ name: 'plan', source: 'extension' }] } })
    await expect(commands).resolves.toEqual({ commands: [{ name: 'plan', source: 'extension' }] })
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

  it('treats an idle snapshot as final state instead of replaying buffered events', async () => {
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
      completedRun: { runId: 'finished', stopReason: 'error' },
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
    expect(snapshots[0]).toMatchObject({ completedRun: { runId: 'finished', stopReason: 'error' } })
    socket.receive({ type: 'session_snapshot', sessionId: 'session-a', atSequence: 3, completedRun: { runId: 42, stopReason: null }, extensionUi: { freshness: 'known', statuses: {}, widgets: {} }, runtime: { lifecycle: 'active', revision: 2 } })
    expect(snapshots.at(-1)).not.toHaveProperty('completedRun')
    expect(statuses).toEqual([{ completedRun: { runId: 'finished', stopReason: 'error' }, lifecycle: 'active', revision: 2, sessionId: 'session-a' }])
    expect(events).toEqual([])
    expect(client.watchedSessions()).toEqual([{ after: 3, role: 'foreground', sessionId: 'session-a' }])
    socket.receive({ event: { type: 'live' }, observedAt: 'later', sequence: 4, sessionId: 'session-a', type: 'pi_event' })
    expect(events).toEqual([4])
    expect(client.shouldApplyExtensionUi({ event: {}, observedAt: 'old', sequence: 3, sessionId: 'session-a' })).toBe(false)
    expect(client.shouldApplyExtensionUi({ event: {}, observedAt: 'new', sequence: 4, sessionId: 'session-a' })).toBe(true)
    vi.unstubAllGlobals()
  })

  it('rewinds only to the active Turn replay boundary supplied by a snapshot', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
    const socket = new FakeSocket()
    const socketFactory = vi.fn(() => socket as never)
    const client = new RuntimeWebSocketClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))),
      socketFactory,
    })
    const events: number[] = []
    client.onPiEvent((event) => events.push(event.sequence))
    const watch = client.watch('session-a', 'foreground', 7)
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce())
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 7 }, sessionId: 'session-a', type: 'watch' }))
    socket.receive({ activeTurn: { prompt: 'continue', runId: 'run-1', startedAt: '2026-09-27T06:12:41.000Z' }, atSequence: 9, extensionUi: { freshness: 'known', statuses: {}, widgets: {} }, replayAfter: 4, runtime: { lifecycle: 'active', revision: 2 }, sessionId: 'session-a', type: 'session_snapshot' })
    socket.receive({ event: { type: 'turn_start' }, observedAt: 'now', sequence: 5, sessionId: 'session-a', type: 'pi_event' })
    socket.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
    await watch

    expect(events).toEqual([5])
    expect(client.watchedSessions()).toEqual([{ after: 5, role: 'foreground', sessionId: 'session-a' }])
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


it('rejects a failed statistics read without publishing a session run error', async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
  const socket = new FakeSocket()
  const factory = vi.fn(() => socket as never)
  const client = new RuntimeWebSocketClient({ fetchFn: vi.fn(async () => new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))), socketFactory: factory })
  const listener = vi.fn()
  client.onError(listener)
  const request = client.getSessionStatistics('session-a')
  const rejected = expect(request).rejects.toThrow('statistics failed')
  await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
  socket.open()
  await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', sessionId: 'session-a', type: 'get_session_stats' }))
  socket.receive({ id: 'web-1', sessionId: 'session-a', type: 'error', code: 'COMMAND_FAILED', message: 'statistics failed' })
  await rejected
  expect(listener).not.toHaveBeenCalled()
  socket.close()
})

it('dedupes statistics for a completed snapshot that also dispatches a runtime status', async () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
  useWorkspaceStore.setState({ extensionStatuses: {}, extensionWidgets: {}, runtimeDetails: {}, runtimeStates: {}, runtimeStatistics: {}, runs: {}, sessionNotifications: {}, watchStates: {} })
  const socket = new FakeSocket()
  const factory = vi.fn(() => socket as never)
  const client = new RuntimeWebSocketClient({
    fetchFn: vi.fn(async () => new Response(JSON.stringify({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))),
    socketFactory: factory,
  })
  const stats = { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 }, cost: 0.01 }
  const getStatistics = vi.spyOn(client, 'getSessionStatistics').mockResolvedValue(stats as never)
  createSessionRunController({ invalidateHistory: vi.fn(), runtime: client })

  const watch = client.watch('session-a')
  await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
  socket.open()
  await vi.waitFor(() => expect(socket.sent).toContainEqual({ id: 'web-1', resume: { after: 0 }, sessionId: 'session-a', type: 'watch' }))
  socket.receive({ command: 'watch', id: 'web-1', sessionId: 'session-a', type: 'ack' })
  await watch

  socket.receive({
    atSequence: 0,
    completedRun: { runId: 'run-1', stopReason: 'stop' },
    extensionUi: { freshness: 'unknown', statuses: {}, widgets: {} },
    runtime: { lifecycle: 'idle', revision: 1 },
    sessionId: 'session-a',
    type: 'session_snapshot',
  })

  await vi.waitFor(() => expect(getStatistics).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(useWorkspaceStore.getState().runtimeStatistics['session-a']?.data).toEqual(stats))
  expect(getStatistics).toHaveBeenCalledTimes(1)
  vi.unstubAllGlobals()
})

it('shares HTTP credentials and refreshes them on WebSocket reconnect after a server restart', async () => {
  vi.resetModules()
  const { RuntimeWebSocketClient: Client } = await import('./runtime-websocket-client.js')
  const { configurationResponse } = await import('./workspace-api.js')
  vi.stubGlobal('window', { location: { href: 'http://localhost:5173/' } })
  let runtimeId = 'old-runtime'
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => url === '/api/runtime/bootstrap'
    ? Response.json({ runtimeId, token: `${runtimeId}-token`, websocketPath: '/api/runtime' }) : Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetcher)
  const first = new FakeSocket()
  const second = new FakeSocket()
  const factory = vi.fn().mockReturnValueOnce(first as never).mockReturnValueOnce(second as never)
  const client = new Client({ socketFactory: factory, reconnectDelay: () => 0 })
  const errors = vi.fn()
  client.onError(errors)
  try {
    const watching = client.watch('session-a')
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1))
    first.open()
    await vi.waitFor(() => expect(first.sent).toHaveLength(1))
    first.receive({ type: 'ack', id: first.sent[0]!.id, command: 'watch', sessionId: 'session-a' })
    await watching
    await configurationResponse('/configuration')
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/runtime/bootstrap')).toHaveLength(1)

    runtimeId = 'new-runtime'
    first.close()
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    expect(factory.mock.calls[1]![0]).toContain('token=new-runtime-token')
    second.open()
    await vi.waitFor(() => expect(second.sent).toHaveLength(1))
    second.receive({ type: 'ack', id: second.sent[0]!.id, command: 'watch', sessionId: 'session-a' })
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: 'RUNTIME_RESTARTED', sessionId: 'session-a' })))
    await configurationResponse('/configuration')
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/runtime/bootstrap')).toHaveLength(2)
    expect(new Headers(fetcher.mock.calls.at(-1)![1]!.headers).get('x-pi-nest-token')).toBe('new-runtime-token')

    const unwatch = client.unwatch('session-a')
    await vi.waitFor(() => expect(second.sent.at(-1)?.type).toBe('unwatch'))
    second.receive({ type: 'ack', id: second.sent.at(-1)!.id, command: 'unwatch', sessionId: 'session-a' })
    await unwatch
  } finally {
    second.close()
    vi.unstubAllGlobals()
  }
})
