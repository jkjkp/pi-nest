import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PiRuntimeEvent } from './runtime-websocket-client.js'
import { createSessionRunController } from './session-run-controller.js'
import { useWorkspaceStore } from './workspace-store.js'

function runtimeMock() {
  const errors = new Set<(error: { code?: string; message: string; sessionId?: string }) => void>()
  const events = new Set<(event: PiRuntimeEvent) => void>()
  const statuses = new Set<(status: { error?: string; lifecycle: any; revision: number; sessionId: string }) => void>()
  const snapshots = new Set<(snapshot: any) => void>()
  const resyncs = new Set<(message: { sessionId: string }) => void>()
  const watches = new Map<string, { after: number; role: 'background' | 'foreground' }>()
  return {
    abort: vi.fn().mockResolvedValue(undefined),
    watch: vi.fn().mockImplementation(async (sessionId: string, role: 'background' | 'foreground' = 'foreground', after = watches.get(sessionId)?.after ?? 0) => { watches.set(sessionId, { after, role }) }),
    unwatch: vi.fn().mockImplementation(async (sessionId: string) => { watches.delete(sessionId) }),
    watchedSessions: vi.fn(() => [...watches].map(([sessionId, watch]) => ({ sessionId, ...watch }))),
    resumeRuntime: vi.fn().mockResolvedValue(undefined),
    getRuntimeState: vi.fn().mockResolvedValue({ isCompacting: false, isStreaming: false }),
    onError: vi.fn((listener: (error: { code?: string; message: string; sessionId?: string }) => void) => { errors.add(listener); return () => errors.delete(listener) }),
    onPiEvent: vi.fn((listener: (event: PiRuntimeEvent) => void) => { events.add(listener); return () => events.delete(listener) }),
    onRuntimeStatus: vi.fn((listener: (status: { error?: string; lifecycle: any; revision: number; sessionId: string }) => void) => { statuses.add(listener); return () => statuses.delete(listener) }),
    onResyncRequired: vi.fn((listener: (message: { sessionId: string }) => void) => { resyncs.add(listener); return () => resyncs.delete(listener) }),
    onSessionSnapshot: vi.fn((listener: (snapshot: any) => void) => { snapshots.add(listener); return () => snapshots.delete(listener) }),
    prompt: vi.fn().mockResolvedValue(undefined),
    emit: (event: PiRuntimeEvent) => { for (const listener of events) listener(event) },
    fail: (error: { message: string; sessionId?: string }) => { for (const listener of errors) listener(error) },
    snapshot: (snapshot: any) => { for (const listener of snapshots) listener(snapshot) },
    resync: (message: { sessionId: string }) => { for (const listener of resyncs) listener(message) },
    status: (status: { error?: string; lifecycle: any; revision: number; sessionId: string }) => { for (const listener of statuses) listener(status) },
  }
}

async function tick() { await Promise.resolve(); await Promise.resolve() }

describe('session run controller', () => {
  beforeEach(() => useWorkspaceStore.setState({ runs: {} }))
  afterEach(() => vi.unstubAllGlobals())

  it('watches, resumes, then prompts and completes from native Pi events', async () => {
    const runtime = runtimeMock()
    const invalidateHistory = vi.fn()
    const controller = createSessionRunController({ invalidateHistory, runtime: runtime as never })

    expect(controller.start({ prompt: 'hello', sessionId: 'session-a' })).toBe(true)
    expect(controller.start({ prompt: 'again', sessionId: 'session-a' })).toBe(false)
    await tick()
    expect(runtime.watch).toHaveBeenCalledWith('session-a', 'foreground')
    expect(runtime.resumeRuntime).toHaveBeenCalledWith('session-a')
    expect(runtime.prompt).toHaveBeenCalledWith('session-a', 'hello')

    runtime.emit({ event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } }, observedAt: 'now', sequence: 1, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }, observedAt: 'now', sequence: 2, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'turn_end' }, observedAt: 'now', sequence: 3, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'agent_settled' }, observedAt: 'now', sequence: 4, sessionId: 'session-a' })
    const completed = useWorkspaceStore.getState().runs['session-a']
    expect(completed).toMatchObject({ status: 'complete', stopReason: 'stop' })
    expect(completed?.turns[0]).toMatchObject({ id: 'pending:session-a', prompt: 'hello' })
    expect(completed?.turns[0]?.events.map((event) => event.event.type)).toEqual(['message_update', 'message_end', 'turn_end'])
    expect(completed?.systemEvents.map((event) => event.event.type)).toEqual(['agent_settled'])
    expect(invalidateHistory).toHaveBeenCalledWith('session-a')
  })

  it('opens a historical session by watching only, without resuming Pi', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })

    controller.openSession('session-a')
    await tick()

    expect(runtime.watch).toHaveBeenCalledWith('session-a', 'foreground')
    expect(runtime.resumeRuntime).not.toHaveBeenCalled()
    expect(runtime.getRuntimeState).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().runs['session-a']).toBeUndefined()

    controller.openSession('session-b')
    await tick()
    expect(runtime.unwatch).toHaveBeenCalledWith('session-a')
    expect(runtime.watch).toHaveBeenCalledWith('session-b', 'foreground')
  })

  it('adopts an already admitted first prompt and never lets later runtime turn IDs add timeline nodes', () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })

    controller.adopt({ historyTurnCount: 0, prompt: 'first prompt', sessionId: 'session-a' })
    runtime.emit({ event: { type: 'turn_start' }, observedAt: 'now', sequence: 1, sessionId: 'session-a', turnId: 'runtime-turn-1' })
    runtime.emit({ event: { type: 'tool_execution_start' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', turnId: 'runtime-turn-2' })

    const run = useWorkspaceStore.getState().runs['session-a']
    expect(run?.turns).toHaveLength(1)
    expect(run?.turns[0]).toMatchObject({ id: 'pending:session-a', prompt: 'first prompt' })
    expect(run?.turns[0]?.events.map((event) => event.turnId)).toEqual(['runtime-turn-1', 'runtime-turn-2'])
  })

  it('keeps an active old foreground session as a background watch', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    controller.openSession('running')
    await tick()
    useWorkspaceStore.getState().setRuntimeState('running', { lifecycle: 'active', revision: 1 })
    controller.openSession('other')
    await tick()
    expect(runtime.watch).toHaveBeenCalledWith('running', 'background')
    expect(runtime.unwatch).not.toHaveBeenCalledWith('running')
  })

  it('aborts only the requested watched session and handles runtime errors', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    controller.start({ prompt: 'A', sessionId: 'session-a' })
    controller.start({ prompt: 'B', sessionId: 'session-b' })
    await tick()

    await expect(controller.stop('session-a')).resolves.toBe(true)
    expect(runtime.abort).toHaveBeenCalledWith('session-a')
    expect(useWorkspaceStore.getState().runs['session-b']?.status).toBe('running')
    runtime.fail({ message: 'prompt failed', sessionId: 'session-b' })
    expect(useWorkspaceStore.getState().runs['session-b']).toMatchObject({ error: 'prompt failed', status: 'error' })
  })

  it('restores foreground and active background watches after refresh', async () => {
    const runtime = runtimeMock()
    runtime.watch.mockImplementationOnce(async (sessionId: string) => { runtime.watchedSessions.mockReturnValueOnce([{ after: 3, role: 'foreground', sessionId }, { after: 4, role: 'background', sessionId: 'session-b' }]) })
    runtime.watchedSessions.mockReturnValue([{ after: 3, role: 'foreground', sessionId: 'session-a' }, { after: 4, role: 'background', sessionId: 'session-b' }])
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })

    controller.resume()
    await tick()
    expect(runtime.watch).toHaveBeenCalledWith('session-a', 'foreground', 3)
    expect(runtime.watch).toHaveBeenCalledWith('session-b', 'background', 4)
  })
})
