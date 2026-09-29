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
    followUp: vi.fn().mockResolvedValue(undefined),
    getRuntimeState: vi.fn().mockResolvedValue({ isCompacting: false, isStreaming: false }),
    onError: vi.fn((listener: (error: { code?: string; message: string; sessionId?: string }) => void) => { errors.add(listener); return () => errors.delete(listener) }),
    onPiEvent: vi.fn((listener: (event: PiRuntimeEvent) => void) => { events.add(listener); return () => events.delete(listener) }),
    onRuntimeStatus: vi.fn((listener: (status: { error?: string; lifecycle: any; revision: number; sessionId: string }) => void) => { statuses.add(listener); return () => statuses.delete(listener) }),
    onResyncRequired: vi.fn((listener: (message: { sessionId: string }) => void) => { resyncs.add(listener); return () => resyncs.delete(listener) }),
    onSessionSnapshot: vi.fn((listener: (snapshot: any) => void) => { snapshots.add(listener); return () => snapshots.delete(listener) }),
    prompt: vi.fn().mockResolvedValue({ runId: 'run-1' }),
    steer: vi.fn().mockResolvedValue(undefined),
    emit: (event: PiRuntimeEvent) => { for (const listener of events) listener(event) },
    fail: (error: { code?: string; message: string; sessionId?: string }) => { for (const listener of errors) listener(error) },
    snapshot: (snapshot: any) => { for (const listener of snapshots) listener(snapshot) },
    resync: (message: { sessionId: string }) => { for (const listener of resyncs) listener(message) },
    status: (status: { error?: string; lifecycle: any; revision: number; sessionId: string }) => { for (const listener of statuses) listener(status) },
  }
}

async function tick() { await Promise.resolve(); await Promise.resolve() }

describe('session run controller', () => {
  beforeEach(() => useWorkspaceStore.setState({ runs: {} }))
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('watches, resumes, then prompts and completes from native Pi events', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-22T00:00:00.000Z'))
    const runtime = runtimeMock()
    const invalidateHistory = vi.fn()
    const controller = createSessionRunController({ invalidateHistory, runtime: runtime as never })

    expect(controller.start({ prompt: 'hello', sessionId: 'session-a' })).toBe(true)
    expect(controller.start({ prompt: 'again', sessionId: 'session-a' })).toBe(false)
    await tick()
    expect(runtime.watch).toHaveBeenCalledWith('session-a', 'foreground')
    expect(runtime.resumeRuntime).toHaveBeenCalledWith('session-a')
    expect(runtime.prompt).toHaveBeenCalledWith('session-a', 'hello')
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('awaiting_agent')

    runtime.emit({ event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } }, observedAt: 'now', runId: 'run-1', sequence: 1, sessionId: 'session-a', turnId: 'turn-1' })
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('running')
    runtime.emit({ event: { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }, observedAt: 'now', runId: 'run-1', sequence: 2, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'turn_end' }, observedAt: 'now', runId: 'run-1', sequence: 3, sessionId: 'session-a', turnId: 'turn-1' })
    vi.setSystemTime(new Date('2026-09-22T00:00:26.000Z'))
    runtime.emit({ event: { type: 'agent_settled' }, observedAt: 'now', runId: 'run-1', sequence: 4, sessionId: 'session-a' })
    const completed = useWorkspaceStore.getState().runs['session-a']
    expect(completed).toMatchObject({ status: 'complete', stopReason: 'stop' })
    expect(completed?.turns[0]).toMatchObject({ completedAt: '2026-09-22T00:00:26.000Z', id: 'pending:session-a', prompt: 'hello', startedAt: '2026-09-22T00:00:00.000Z' })
    expect(completed?.turns[0]?.events.map((event) => event.event.type)).toEqual(['message_update', 'message_end', 'turn_end'])
    expect(completed?.systemEvents.map((event) => event.event.type)).toEqual(['agent_settled'])
    expect(invalidateHistory).toHaveBeenCalledWith('session-a')
  })

  it('does not let a delayed settlement from another prompt complete this run', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })

    expect(controller.start({ prompt: 'implement the plan', sessionId: 'session-a' })).toBe(true)
    await tick()
    runtime.emit({ event: { type: 'agent_settled' }, observedAt: 'now', runId: 'previous-run', sequence: 1, sessionId: 'session-a' })
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('awaiting_agent')

    runtime.emit({ event: { type: 'turn_start' }, observedAt: 'now', runId: 'run-1', sequence: 2, sessionId: 'session-a', turnId: 'turn-2' })
    runtime.emit({ event: { type: 'agent_settled' }, observedAt: 'now', runId: 'run-1', sequence: 3, sessionId: 'session-a', turnId: 'turn-2' })
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('complete')
  })

  it('keeps an acknowledged prompt in a visible waiting state while Pi is streaming without events', async () => {
    vi.useFakeTimers()
    const runtime = runtimeMock()
    runtime.getRuntimeState.mockResolvedValue({ isCompacting: false, isStreaming: true })
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })

    controller.start({ prompt: 'Implement the plan.', sessionId: 'session-a' })
    await tick()
    await vi.advanceTimersByTimeAsync(4_000)
    await tick()

    expect(runtime.getRuntimeState).toHaveBeenCalledWith('session-a')
    expect(useWorkspaceStore.getState().runs['session-a']).toMatchObject({ status: 'awaiting_agent', waitingMessage: 'Pi 正在处理，等待首个执行事件…' })
  })

  it('shows an acknowledged running input immediately and removes it once Pi records the user message', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    controller.start({ prompt: 'first', sessionId: 'session-a' })
    await tick()

    await controller.followUp('session-a', 'find the latest AI news')
    expect(runtime.followUp).toHaveBeenCalledWith('session-a', 'find the latest AI news')
    expect(useWorkspaceStore.getState().runs['session-a']?.pendingInputs).toMatchObject([{ message: 'find the latest AI news', mode: 'follow_up' }])

    runtime.emit({ event: { message: { content: 'find the latest AI news', role: 'user' }, type: 'message' }, observedAt: 'now', runId: 'run-1', sequence: 1, sessionId: 'session-a', turnId: 'turn-1' })
    expect(useWorkspaceStore.getState().runs['session-a']?.pendingInputs).toEqual([])
  })

  it('adopts a Pi Extension-started turn from its native user message and settles that run only', () => {
    const runtime = runtimeMock()
    const invalidateHistory = vi.fn()
    createSessionRunController({ invalidateHistory, runtime: runtime as never })

    runtime.status({ lifecycle: 'active', revision: 1, sessionId: 'session-a' })
    runtime.emit({ event: { type: 'agent_start' }, observedAt: '2026-09-27T11:32:58.000Z', runId: 'extension-run', sequence: 1, sessionId: 'session-a' })
    runtime.emit({ event: { message: { content: [{ text: 'Implement the plan.', type: 'text' }], role: 'user' }, type: 'message_start' }, observedAt: '2026-09-27T11:32:59.000Z', runId: 'extension-run', sequence: 2, sessionId: 'session-a' })
    runtime.emit({ event: { type: 'message_update', assistantMessageEvent: { delta: 'Working…', type: 'text_delta' } }, observedAt: '2026-09-27T11:33:00.000Z', runId: 'extension-run', sequence: 3, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'agent_settled' }, observedAt: '2026-09-27T11:33:01.000Z', runId: 'other-run', sequence: 4, sessionId: 'session-a' })
    expect(useWorkspaceStore.getState().runs['session-a']).toMatchObject({ status: 'running', turns: [{ prompt: 'Implement the plan.' }] })

    runtime.emit({ event: { type: 'agent_settled' }, observedAt: '2026-09-27T11:33:02.000Z', runId: 'extension-run', sequence: 5, sessionId: 'session-a' })
    expect(useWorkspaceStore.getState().runs['session-a']).toMatchObject({ status: 'complete', turns: [{ completedAt: expect.any(String), prompt: 'Implement the plan.' }] })
    expect(invalidateHistory).toHaveBeenCalledWith('session-a')
  })

  it('continues from a settled plan with the Pi CLI implementation prompt before Pi reports a user message', () => {
    const runtime = runtimeMock()
    createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    useWorkspaceStore.setState({
      runs: {
        'session-a': { pendingInputs: [], status: 'complete', systemEvents: [], turns: [{ completedAt: '2026-09-29T16:47:50.000Z', events: [], id: 'plan', prompt: '/plan research', startedAt: '2026-09-29T16:47:05.000Z' }] },
      },
    })
    useWorkspaceStore.getState().appendPendingInput('session-a', { id: 'plan-implementation:plan-action', message: 'Implement the plan.', mode: 'plan_implementation', submittedAt: '2026-09-29T16:47:50.000Z' })

    runtime.emit({ event: { type: 'agent_start' }, observedAt: '2026-09-29T16:47:50.337Z', runId: 'implementation-run', sequence: 1, sessionId: 'session-a' })
    runtime.emit({ event: { type: 'message_update', assistantMessageEvent: { delta: 'Working…', type: 'thinking_delta' } }, observedAt: '2026-09-29T16:47:51.000Z', runId: 'implementation-run', sequence: 2, sessionId: 'session-a', turnId: 'turn-1' })

    expect(useWorkspaceStore.getState().runs['session-a']).toMatchObject({ status: 'running', turns: [{ prompt: '/plan research' }, { prompt: 'Implement the plan.' }] })
    expect(useWorkspaceStore.getState().runs['session-a']?.turns.at(-1)?.events.map((event) => event.event.type)).toEqual(['message_update'])

    runtime.emit({ event: { messages: [{ content: [{ text: 'Implement the plan.', type: 'text' }], role: 'user' }], type: 'agent_end' }, observedAt: '2026-09-29T16:48:34.913Z', runId: 'implementation-run', sequence: 3, sessionId: 'session-a' })
    expect(useWorkspaceStore.getState().runs['session-a']?.turns.at(-1)).toMatchObject({ prompt: 'Implement the plan.' })
  })

  it('restores a native active run with no prompt, then adopts its replayed Pi user message', () => {
    const runtime = runtimeMock()
    createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })

    runtime.snapshot({ activeTurn: { runId: 'extension-run', startedAt: '2026-09-27T11:32:58.000Z' }, runtime: { lifecycle: 'active', revision: 2 }, sessionId: 'session-a' })
    runtime.emit({ event: { message: { content: 'Implement the plan.', role: 'user' }, type: 'message' }, observedAt: '2026-09-27T11:32:59.000Z', runId: 'extension-run', sequence: 2, sessionId: 'session-a' })

    expect(useWorkspaceStore.getState().runs['session-a']).toMatchObject({ status: 'running', turns: [{ prompt: 'Implement the plan.' }] })
  })

  it('restores a pending extension dialog without recreating a streaming thought turn', () => {
    const runtime = runtimeMock()
    createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })

    runtime.snapshot({ activeTurn: { prompt: 'make a plan', runId: 'run-1', startedAt: '2026-09-30T00:00:00.000Z', waitingForExtension: true }, runtime: { lifecycle: 'active', revision: 2 }, sessionId: 'session-a' })

    expect(useWorkspaceStore.getState().runs['session-a']).toMatchObject({ status: 'awaiting_input', turns: [] })
  })

  it('does not show a running input when Pi rejects it', async () => {
    const runtime = runtimeMock()
    runtime.steer.mockRejectedValueOnce(new Error('Pi session is not running'))
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    controller.start({ prompt: 'first', sessionId: 'session-a' })
    await tick()

    await expect(controller.steer('session-a', 'change direction')).rejects.toThrow('Pi session is not running')
    expect(useWorkspaceStore.getState().runs['session-a']?.pendingInputs).toEqual([])
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

  it('rebuilds an active Turn from its snapshot and makes a runtime restart visible', () => {
    const runtime = runtimeMock()
    createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })

    runtime.snapshot({ activeTurn: { prompt: 'resume me', runId: 'run-1', startedAt: '2026-09-27T06:12:41.000Z' }, runtime: { lifecycle: 'active', revision: 2 }, sessionId: 'session-a' })
    runtime.emit({ event: { type: 'message_update', assistantMessageEvent: { delta: 'thinking', type: 'thinking_delta' } }, observedAt: 'now', runId: 'run-1', sequence: 5, sessionId: 'session-a', turnId: 'turn-1' })

    expect(useWorkspaceStore.getState().runs['session-a']).toMatchObject({ status: 'running', turns: [{ prompt: 'resume me', startedAt: '2026-09-27T06:12:41.000Z' }] })
    expect(useWorkspaceStore.getState().runs['session-a']?.turns[0]?.events).toHaveLength(1)
    runtime.fail({ code: 'RUNTIME_RESTARTED', message: 'Pi runtime server restarted', sessionId: 'session-a' })
    expect(useWorkspaceStore.getState().runs['session-a']).toMatchObject({ error: 'Pi 运行服务已重启，本轮已中断。', status: 'error' })
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
    expect(useWorkspaceStore.getState().runs['session-b']?.status).toBe('awaiting_agent')
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
