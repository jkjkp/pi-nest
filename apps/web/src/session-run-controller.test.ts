import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PiRuntimeEvent } from './runtime-websocket-client.js'
import { createSessionRunController } from './session-run-controller.js'
import { useWorkspaceStore } from './workspace-store.js'

function runtimeMock() {
  const errors = new Set<(error: { message: string; sessionId?: string }) => void>()
  const events = new Set<(event: PiRuntimeEvent) => void>()
  return {
    abort: vi.fn().mockResolvedValue(undefined),
    attach: vi.fn().mockResolvedValue(undefined),
    getRuntimeState: vi.fn().mockResolvedValue({ isCompacting: false, isStreaming: false }),
    onError: vi.fn((listener: (error: { message: string; sessionId?: string }) => void) => { errors.add(listener); return () => errors.delete(listener) }),
    onPiEvent: vi.fn((listener: (event: PiRuntimeEvent) => void) => { events.add(listener); return () => events.delete(listener) }),
    prompt: vi.fn().mockResolvedValue(undefined),
    emit: (event: PiRuntimeEvent) => { for (const listener of events) listener(event) },
    fail: (error: { message: string; sessionId?: string }) => { for (const listener of errors) listener(error) },
  }
}

async function tick() { await Promise.resolve(); await Promise.resolve() }

describe('session run controller', () => {
  beforeEach(() => useWorkspaceStore.setState({ runs: {} }))
  afterEach(() => vi.unstubAllGlobals())

  it('attaches before prompting and completes from native Pi events', async () => {
    const runtime = runtimeMock()
    const invalidateHistory = vi.fn()
    const controller = createSessionRunController({ invalidateHistory, runtime: runtime as never })

    expect(controller.start({ prompt: 'hello', sessionId: 'session-a' })).toBe(true)
    expect(controller.start({ prompt: 'again', sessionId: 'session-a' })).toBe(false)
    await tick()
    expect(runtime.attach).toHaveBeenCalledWith('session-a')
    expect(runtime.prompt).toHaveBeenCalledWith('session-a', 'hello')

    runtime.emit({ event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } }, observedAt: 'now', sequence: 1, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }, observedAt: 'now', sequence: 2, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'turn_end' }, observedAt: 'now', sequence: 3, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'agent_settled' }, observedAt: 'now', sequence: 4, sessionId: 'session-a' })
    const completed = useWorkspaceStore.getState().runs['session-a']
    expect(completed).toMatchObject({ status: 'complete', stopReason: 'stop' })
    expect(completed?.turns[0]).toMatchObject({ id: 'turn-1', prompt: 'hello' })
    expect(completed?.turns[0]?.events.map((event) => event.event.type)).toEqual(['message_update', 'message_end', 'turn_end'])
    expect(completed?.systemEvents.map((event) => event.event.type)).toEqual(['agent_settled'])
    expect(invalidateHistory).toHaveBeenCalledWith('session-a')
  })

  it('opens a session by subscribing and warming the native runtime for extension UI', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })

    controller.openSession('session-a')
    await tick()

    expect(runtime.attach).toHaveBeenCalledWith('session-a')
    expect(runtime.getRuntimeState).toHaveBeenCalledWith('session-a')
    expect(useWorkspaceStore.getState().runs['session-a']).toBeUndefined()

    runtime.getRuntimeState.mockRejectedValueOnce(new Error('Pi session is busy'))
    controller.openSession('session-b')
    await tick()
    expect(runtime.attach).toHaveBeenCalledWith('session-b')
  })

  it('aborts only the requested attached session and handles runtime errors', async () => {
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

  it('restores an active turn after refresh and clears its session-only marker when Pi settles', async () => {
    const storage = new Map<string, string>([['pi-nest-active-runtime-sessions', JSON.stringify(['session-a'])]])
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    })
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })

    controller.resume()
    await tick()
    expect(runtime.attach).toHaveBeenCalledWith('session-a', 0)
    runtime.emit({ event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Recovered' } }, observedAt: 'now', sequence: 1, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'turn_end' }, observedAt: 'now', sequence: 2, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'agent_settled' }, observedAt: 'now', sequence: 3, sessionId: 'session-a' })
    const recovered = useWorkspaceStore.getState().runs['session-a']
    expect(recovered?.status).toBe('complete')
    expect(recovered?.turns[0]?.events.map((event) => event.event.type)).toEqual(['message_update', 'turn_end'])
    expect(recovered?.systemEvents.map((event) => event.event.type)).toEqual(['agent_settled'])
    expect(storage.get('pi-nest-active-runtime-sessions')).toBe('[]')
  })
})
