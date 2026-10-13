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
    shouldApplyExtensionUi: vi.fn(() => true),
    watchedSessions: vi.fn(() => [...watches].map(([sessionId, watch]) => ({ sessionId, ...watch }))),
    resumeRuntime: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    getSessionStatistics: vi.fn().mockResolvedValue({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
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
    snapshot: (snapshot: any) => { for (const listener of snapshots) listener({ atSequence: 0, extensionUi: { freshness: 'unknown', statuses: {}, widgets: {} }, ...snapshot }) },
    resync: (message: { sessionId: string }) => { for (const listener of resyncs) listener(message) },
    status: (status: { error?: string; lifecycle: any; revision: number; sessionId: string }) => { for (const listener of statuses) listener(status) },
  }
}

async function tick() { for (let index = 0; index < 12; index++) await Promise.resolve() }

describe('session run controller', () => {
  beforeEach(() => useWorkspaceStore.setState({ sessionNotifications: {}, runs: {}, runtimeDetails: {}, runtimeStates: {}, watchStates: {}, extensionStatuses: {}, extensionWidgets: {}, drafts: {} }))
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('keeps the background watch through idle and records completion once', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    controller.openSession('session-a')
    controller.start({ sessionId: 'session-a', prompt: 'hello' })
    await tick()
    controller.openSession('session-b')
    await tick()
    runtime.status({ sessionId: 'session-a', lifecycle: 'idle', revision: 2 })
    expect(runtime.unwatch).not.toHaveBeenCalledWith('session-a')
    runtime.emit({ sessionId: 'session-a', runId: 'run-1', sequence: 1, observedAt: 'now', event: { type: 'agent_settled' } })
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('complete')
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']).toMatchObject({ completedRunId: 'run-1', readRunId: undefined, pendingRunId: undefined })
    expect(runtime.unwatch).toHaveBeenCalledWith('session-a')
    useWorkspaceStore.getState().markSessionRead('session-a', 'run-1')
    runtime.snapshot({ sessionId: 'session-a', runtime: { lifecycle: 'idle', revision: 2 }, completedRun: { runId: 'run-1', stopReason: 'stop' } })
    runtime.emit({ sessionId: 'session-a', runId: 'run-1', sequence: 1, observedAt: 'now', event: { type: 'agent_start' } })
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']?.readRunId).toBe('run-1')
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('complete')
  })

  it('recovers a known pending completion from an idle snapshot without flagging old history', () => {
    const runtime = runtimeMock()
    const snapshot = { sessionId: 'session-a', runtime: { lifecycle: 'idle', revision: 2 }, completedRun: { runId: 'run-1', stopReason: 'stop' } }
    createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    runtime.snapshot(snapshot)
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']).toBeUndefined()
    useWorkspaceStore.getState().trackPendingRun('session-a', 'run-1')
    runtime.snapshot(snapshot)
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']?.completedRunId).toBe('run-1')
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('complete')
  })

  it.each(['error', 'aborted'])('does not create an unread completion for %s', async (stopReason) => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    controller.start({ sessionId: 'session-a', prompt: 'hello' })
    await tick()
    runtime.emit({ sessionId: 'session-a', runId: 'run-1', sequence: 1, observedAt: 'now', event: { type: 'message_end', message: { role: 'assistant', stopReason } } })
    runtime.emit({ sessionId: 'session-a', runId: 'run-1', sequence: 2, observedAt: 'now', event: { type: 'agent_settled' } })
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe(stopReason)
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']?.completedRunId).toBeUndefined()
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']?.pendingRunId).toBeUndefined()
  })

  it('marks an upstream abort without an assistant message and suppresses completion notification', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    controller.start({ sessionId: 'session-a', prompt: 'hello' })
    await tick()
    runtime.emit({ sessionId: 'session-a', runId: 'run-1', sequence: 1, observedAt: 'now', event: { type: 'agent_settled', aborted: true } })
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('aborted')
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']?.completedRunId).toBeUndefined()
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']?.pendingRunId).toBeUndefined()
  })

  it('finishes a handled extension command from idle status without an agent_settled event', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    controller.start({ sessionId: 'session-a', prompt: '/extension-command' })
    await tick()
    runtime.emit({ sessionId: 'session-a', runId: 'run-1', sequence: 1, observedAt: 'now', event: { type: 'extension_ui_request', id: 'dialog-1', method: 'confirm' } })
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('awaiting_input')
    runtime.status({ sessionId: 'session-a', lifecycle: 'idle', revision: 2, completedRun: { runId: 'old-run', stopReason: 'stop' } } as never)
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('awaiting_input')
    runtime.status({ sessionId: 'session-a', lifecycle: 'idle', revision: 3, completedRun: { runId: 'run-1', stopReason: 'stop' } } as never)
    expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('complete')
    expect(controller.start({ sessionId: 'session-a', prompt: 'next' })).toBe(true)
  })

  it.each(['visible', 'hidden'])('marks foreground completion according to document visibility: %s', async (visibilityState) => {
    vi.stubGlobal('document', { visibilityState })
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    controller.openSession('session-a')
    controller.start({ sessionId: 'session-a', prompt: 'hello' })
    await tick()
    runtime.emit({ sessionId: 'session-a', runId: 'run-1', sequence: 1, observedAt: 'now', event: { type: 'agent_settled' } })
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']?.readRunId).toBe(visibilityState === 'visible' ? 'run-1' : undefined)
  })

  it('does not let an old read acknowledgement clear a newer reply', () => {
    const store = useWorkspaceStore.getState()
    store.trackPendingRun('session-a', 'one')
    store.finishNotification('session-a', 'one', true, true)
    store.trackPendingRun('session-a', 'two')
    store.finishNotification('session-a', 'two', true, true)
    store.markSessionRead('session-a', 'one')
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']?.readRunId).toBeUndefined()
    store.markSessionRead('session-a', 'two')
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']?.readRunId).toBe('two')
    store.removeSessionNotification('session-a')
    expect(useWorkspaceStore.getState().sessionNotifications['session-a']).toBeUndefined()
  })

  it('restores the active model from snapshots and ignores older revisions without RPC reads', () => {
    const runtime = runtimeMock()
    createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    runtime.snapshot({ sessionId: 'session-a', runtime: { lifecycle: 'active', revision: 3, model: { provider: 'test', id: 'selected' } } })
    expect(useWorkspaceStore.getState().runtimeDetails['session-a']?.model?.id).toBe('selected')
    runtime.snapshot({ sessionId: 'session-a', runtime: { lifecycle: 'idle', revision: 2, model: { provider: 'test', id: 'old' } } })
    expect(useWorkspaceStore.getState().runtimeDetails['session-a']?.model?.id).toBe('selected')
    runtime.status({ sessionId: 'session-b', lifecycle: 'idle', revision: 1, model: { provider: 'other', id: 'default' } } as never)
    expect(useWorkspaceStore.getState().runtimeDetails['session-b']?.model?.id).toBe('default')
    expect(runtime.getRuntimeState).not.toHaveBeenCalled()
  })

  it('shares runtime loading between automatic initialization and prompt submission', async () => {
    const runtime = runtimeMock()
    let release!: () => void
    runtime.resumeRuntime.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    const loading = controller.resumeRuntime('session-a')
    controller.start({ prompt: 'hello', sessionId: 'session-a' })
    await tick()
    expect(runtime.resumeRuntime).toHaveBeenCalledTimes(1)
    expect(runtime.prompt).not.toHaveBeenCalled()
    release()
    await loading
    await tick()
    expect(runtime.prompt).toHaveBeenCalledWith('session-a', 'hello')
  })

  it('syncs thinking from snapshots and live events while filtering replayed updates', () => {
    const runtime = runtimeMock()
    createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    runtime.snapshot({ sessionId: 'session-a', runtime: { lifecycle: 'active', revision: 3, thinkingLevel: 'high' } })
    expect(useWorkspaceStore.getState().runtimeDetails['session-a']?.thinkingLevel).toBe('high')
    runtime.shouldApplyExtensionUi.mockReturnValue(false)
    runtime.emit({ event: { type: 'thinking_level_changed', level: 'low' }, observedAt: 'now', sequence: 1, sessionId: 'session-a' })
    expect(useWorkspaceStore.getState().runtimeDetails['session-a']?.thinkingLevel).toBe('high')
    runtime.shouldApplyExtensionUi.mockReturnValue(true)
    runtime.emit({ event: { type: 'thinking_level_changed', level: 'medium' }, observedAt: 'now', sequence: 2, sessionId: 'session-a' })
    expect(useWorkspaceStore.getState().runtimeDetails['session-a']?.thinkingLevel).toBe('medium')
    runtime.snapshot({ sessionId: 'session-a', runtime: { lifecycle: 'idle', revision: 2, thinkingLevel: 'off' } })
    expect(useWorkspaceStore.getState().runtimeDetails['session-a']?.thinkingLevel).toBe('medium')
  })

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
    expect(completed?.turns[0]).toMatchObject({ completedAt: '2026-09-22T00:00:26.000Z', id: expect.stringMatching(/^pending:session-a:/), prompt: 'hello', startedAt: '2026-09-22T00:00:00.000Z' })
    expect(completed?.turns[0]?.events.map((event) => event.event.type)).toEqual(['message_update', 'message_end', 'turn_end'])
    expect(completed?.systemEvents.map((event) => event.event.type)).toEqual(['agent_settled'])
    expect(invalidateHistory).toHaveBeenCalledWith('session-a')
  })

  it('retains a completed response when another prompt starts before history catches up', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    controller.start({ prompt: 'first', sessionId: 'session-a' })
    await tick()
    runtime.emit({ event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first answer' } }, observedAt: 'now', runId: 'run-1', sequence: 1, sessionId: 'session-a', turnId: 'turn-1' })
    runtime.emit({ event: { type: 'agent_settled' }, observedAt: 'now', runId: 'run-1', sequence: 2, sessionId: 'session-a' })
    const first = useWorkspaceStore.getState().runs['session-a']!.turns[0]
    expect(controller.start({ prompt: 'second', sessionId: 'session-a' })).toBe(true)
    expect(useWorkspaceStore.getState().runs['session-a']!.turns[0]).toBe(first)
    expect(useWorkspaceStore.getState().runs['session-a']!.turns.at(-1)?.prompt).toBe('second')
    await tick()
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
    expect(run?.turns[0]).toMatchObject({ id: expect.stringMatching(/^pending:session-a:/), prompt: 'first prompt' })
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
  it('owns runtime and extension projections without an extension UI component', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    runtime.snapshot({ sessionId: 'session-a', runtime: { lifecycle: 'idle', revision: 2 }, extensionUi: { freshness: 'restored', statuses: { plan: 'planning' }, widgets: { plan: ['step one'] } } })
    expect(useWorkspaceStore.getState()).toMatchObject({
      runtimeStates: { 'session-a': { lifecycle: 'idle', revision: 2 } },
      watchStates: { 'session-a': 'ready' },
      extensionStatuses: { 'session-a': { plan: 'planning' } },
      extensionWidgets: { 'session-a': { plan: ['step one'] } },
    })
    const emit = (event: Record<string, unknown>) => runtime.emit({ event, sessionId: 'session-a', sequence: 3, observedAt: 'now' })
    emit({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'plan', statusText: 'implementing' })
    emit({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'plan', widgetLines: ['step two'] })
    emit({ type: 'extension_ui_request', method: 'set_editor_text', text: '\u001b[31mnext prompt\u001b[0m' })
    expect(useWorkspaceStore.getState().extensionStatuses['session-a']).toEqual({ plan: 'implementing' })
    expect(useWorkspaceStore.getState().extensionWidgets['session-a']).toEqual({ plan: ['step two'] })
    expect(useWorkspaceStore.getState().drafts['session-a']).toBe('next prompt')
    runtime.shouldApplyExtensionUi.mockReturnValue(false)
    emit({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'plan', statusText: 'old' })
    expect(useWorkspaceStore.getState().extensionStatuses['session-a']).toEqual({ plan: 'implementing' })
    runtime.getRuntimeState.mockResolvedValueOnce({ isCompacting: false, isStreaming: false, model: { id: 'model', provider: 'provider' } } as any)
    await expect(controller.getRuntimeState('session-a')).resolves.toMatchObject({ model: { id: 'model' } })
    expect(useWorkspaceStore.getState().runtimeDetails['session-a']?.model).toEqual({ provider: 'provider', id: 'model' })
  })

  it('reads back the confirmed model and thinking level after switching without creating a run', async () => {
    const runtime = runtimeMock()
    const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    useWorkspaceStore.getState().setRuntimeDetails('session-b', { isCompacting: false, isStreaming: false, model: { id: 'other', provider: 'test' } })
    runtime.getRuntimeState.mockResolvedValueOnce({ isCompacting: false, isStreaming: false, model: { id: 'confirmed', provider: 'test' }, thinkingLevel: 'high' } as any)
    await controller.setModel('session-a', 'test', 'requested')
    expect(runtime.setModel).toHaveBeenCalledWith('session-a', 'test', 'requested')
    expect(runtime.getRuntimeState).toHaveBeenCalledWith('session-a')
    expect(useWorkspaceStore.getState().runtimeDetails['session-a']).toMatchObject({ model: { id: 'confirmed' }, thinkingLevel: 'high' })
    expect(useWorkspaceStore.getState().runtimeDetails['session-b']?.model?.id).toBe('other')
    expect(useWorkspaceStore.getState().runs['session-a']).toBeUndefined()
    runtime.setModel.mockRejectedValueOnce(new Error('invalid model'))
    await expect(controller.setModel('session-a', 'test', 'invalid')).rejects.toThrow('invalid model')
    expect(useWorkspaceStore.getState().runtimeDetails['session-a']?.model?.id).toBe('confirmed')
    useWorkspaceStore.getState().clearRuntimeState('session-a')
    expect(useWorkspaceStore.getState().runtimeDetails['session-a']).toBeUndefined()
  })

  it('ignores older runtime revisions and clears projections on failure and resync', () => {
    const runtime = runtimeMock()
    createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
    const snapshot = { sessionId: 'session-a', runtime: { lifecycle: 'idle', revision: 5 }, extensionUi: { freshness: 'known', statuses: { plan: 'current' }, widgets: { plan: ['current'] } } }
    runtime.snapshot(snapshot)
    runtime.status({ sessionId: 'session-a', lifecycle: 'failed', revision: 4 })
    runtime.snapshot({ ...snapshot, runtime: { lifecycle: 'active', revision: 3 }, extensionUi: { freshness: 'known', statuses: {}, widgets: {} } })
    expect(useWorkspaceStore.getState().runtimeStates['session-a']).toMatchObject({ lifecycle: 'idle', revision: 5 })
    expect(useWorkspaceStore.getState().extensionStatuses['session-a']).toEqual({ plan: 'current' })
    runtime.status({ sessionId: 'session-a', lifecycle: 'failed', revision: 6 })
    expect(useWorkspaceStore.getState().extensionStatuses['session-a']).toEqual({})
    expect(useWorkspaceStore.getState().extensionWidgets['session-a']).toEqual({})
    runtime.snapshot({ ...snapshot, runtime: { lifecycle: 'idle', revision: 7 } })
    runtime.resync({ sessionId: 'session-a' })
    expect(useWorkspaceStore.getState().extensionStatuses['session-a']).toEqual({})
    runtime.snapshot({ ...snapshot, runtime: { lifecycle: 'idle', revision: 0 } })
    expect(useWorkspaceStore.getState().runtimeStates['session-a']?.revision).toBe(0)
    runtime.fail({ code: 'RUNTIME_RESTARTED', message: 'restart', sessionId: 'session-a' })
    runtime.snapshot({ ...snapshot, runtime: { lifecycle: 'idle', revision: 0 } })
    expect(useWorkspaceStore.getState().runtimeStates['session-a']?.revision).toBe(0)
  })

})


it('ends a rejected model call as an error and allows the next prompt to succeed', async () => {
  useWorkspaceStore.setState({ sessionNotifications: {}, runs: {}, runtimeDetails: {}, runtimeStates: {}, watchStates: {} })
  const runtime = runtimeMock()
  const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
  expect(controller.start({ prompt: 'first', sessionId: 'session-a' })).toBe(true)
  await tick()
  runtime.emit({ event: { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '403: denied' } }, observedAt: 'now', runId: 'run-1', sequence: 1, sessionId: 'session-a', turnId: 'turn-1' })
  runtime.emit({ event: { type: 'agent_settled' }, observedAt: 'now', runId: 'run-1', sequence: 2, sessionId: 'session-a' })
  expect(useWorkspaceStore.getState().runs['session-a']).toMatchObject({ status: 'error', stopReason: 'error' })
  expect(useWorkspaceStore.getState().runs['session-b']).toBeUndefined()
  expect(controller.start({ prompt: 'next', sessionId: 'session-a' })).toBe(true)
  await tick()
  runtime.emit({ event: { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }, observedAt: 'now', runId: 'run-1', sequence: 3, sessionId: 'session-a', turnId: 'turn-2' })
  runtime.emit({ event: { type: 'agent_settled' }, observedAt: 'now', runId: 'run-1', sequence: 4, sessionId: 'session-a' })
  expect(useWorkspaceStore.getState().runs['session-a']).toMatchObject({ status: 'complete', stopReason: 'stop' })
})

it('isolates session statistics, rejects superseded responses and survives failed reads', async () => {
  useWorkspaceStore.setState({ sessionNotifications: {}, runs: {}, runtimeDetails: {}, runtimeStates: {}, runtimeStatistics: {} })
  const runtime = runtimeMock()
  let release!: (stats: any) => void
  runtime.getSessionStatistics.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
  const older = controller.getSessionStatistics('session-a')
  const newerStats = { tokens: { input: 20, output: 10, cacheRead: 90, cacheWrite: 0, total: 120 }, cost: 0.1, contextUsage: { tokens: null, percent: null, contextWindow: 1000000 } }
  runtime.getSessionStatistics.mockResolvedValueOnce(newerStats as never)
  await controller.getSessionStatistics('session-a')
  release({ ...newerStats, cost: 999 })
  await older
  expect(useWorkspaceStore.getState().runtimeStatistics['session-a']?.data).toEqual(newerStats)
  await controller.getSessionStatistics('session-b')
  expect(useWorkspaceStore.getState().runtimeStatistics['session-b']?.data?.cost).toBe(0)
  runtime.getSessionStatistics.mockRejectedValueOnce(new Error('failed'))
  await controller.getSessionStatistics('session-a')
  expect(useWorkspaceStore.getState().runtimeStatistics['session-a']).toMatchObject({ data: newerStats, loading: false, error: expect.stringContaining('读取失败') })
  expect(useWorkspaceStore.getState().runs['session-a']).toBeUndefined()
})

it('does not resurrect statistics from a request interrupted by resync', async () => {
  useWorkspaceStore.setState({ sessionNotifications: {}, runs: {}, runtimeDetails: {}, runtimeStates: {}, runtimeStatistics: {} })
  const runtime = runtimeMock()
  let release!: (stats: any) => void
  runtime.getSessionStatistics.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
  const pending = controller.getSessionStatistics('session-a')
  runtime.resync({ sessionId: 'session-a' })
  release({ cost: 999 })
  await pending
  expect(useWorkspaceStore.getState().runtimeStatistics['session-a']).toBeUndefined()
})

it('refreshes statistics on restoration, compaction and model changes instead of token deltas', async () => {
  useWorkspaceStore.setState({ sessionNotifications: {}, runs: {}, runtimeDetails: {}, runtimeStates: {}, runtimeStatistics: {} })
  const runtime = runtimeMock()
  const controller = createSessionRunController({ invalidateHistory: vi.fn(), runtime: runtime as never })
  runtime.snapshot({ sessionId: 'session-a', runtime: { lifecycle: 'idle', revision: 1 } })
  await tick()
  expect(runtime.getSessionStatistics).toHaveBeenCalledTimes(1)
  for (let sequence = 1; sequence <= 20; sequence++) runtime.emit({ event: { type: 'message_update' }, observedAt: 'now', sequence, sessionId: 'session-a' })
  expect(runtime.getSessionStatistics).toHaveBeenCalledTimes(1)
  runtime.emit({ event: { type: 'auto_compaction_end' }, observedAt: 'now', sequence: 21, sessionId: 'session-a' })
  await tick()
  expect(runtime.getSessionStatistics).toHaveBeenCalledTimes(2)
  await controller.setModel('session-a', 'test', 'model')
  expect(runtime.getSessionStatistics).toHaveBeenCalledTimes(3)
})
