import { isRuntimeConnectionError, RuntimeWebSocketClient, type PiRuntimeEvent, type PiRuntimeModel, type PiRuntimeState } from './runtime-websocket-client.js'
import { nativeUserMessage, type PromptStatus, useWorkspaceStore } from './workspace-store.js'

type SessionRunControllerOptions = {
  invalidateHistory: (sessionId: string) => void | Promise<void>
  runtime: RuntimeWebSocketClient
}

type StartSessionRunOptions = { historyTurnCount?: number; prompt: string; sessionId: string; startedAt?: string }
type ActiveRun = { awaitingRunId: boolean; runId: string | undefined; stopReason: string | undefined }

export type SessionRunController = {
  adopt: (options: StartSessionRunOptions) => void
  compact: (sessionId: string) => Promise<void>
  followUp: (sessionId: string, message: string) => Promise<void>
  getAvailableModels: (sessionId: string) => Promise<PiRuntimeModel[]>
  getAvailableThinkingLevels: (sessionId: string) => Promise<string[]>
  getRuntimeState: (sessionId: string) => Promise<PiRuntimeState>
  openSession: (sessionId: string) => void
  releaseForeground: () => void
  resume: () => void
  resumeRuntime: (sessionId: string) => Promise<void>
  setModel: (sessionId: string, provider: string, modelId: string) => Promise<void>
  setThinkingLevel: (sessionId: string, level: string) => Promise<void>
  start: (options: StartSessionRunOptions) => boolean
  steer: (sessionId: string, message: string) => Promise<void>
  stop: (sessionId: string) => Promise<boolean>
}

function assistantStopReason(event: PiRuntimeEvent) {
  if (event.event.type !== 'message_end') return undefined
  const message = event.event.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  const candidate = message as Record<string, unknown>
  return candidate.role === 'assistant' && typeof candidate.stopReason === 'string' ? candidate.stopReason : undefined
}

function startsExecution(event: PiRuntimeEvent) {
  const type = event.event.type
  if (type === 'agent_start' || type === 'turn_start' || type === 'message_update' || (typeof type === 'string' && type.startsWith('tool_execution_'))) return true
  if (type !== 'message') return false
  const message = event.event.message
  return Boolean(message && typeof message === 'object' && !Array.isArray(message) && ['assistant', 'toolResult'].includes((message as Record<string, unknown>).role as string))
}

function isExtensionDialog(event: PiRuntimeEvent) {
  const request = event.event
  return request.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(request.method as string)
}

export function createSessionRunController({ invalidateHistory, runtime }: SessionRunControllerOptions): SessionRunController {
  const activeRuns = new Map<string, ActiveRun>()
  const awaitingAgentTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let foregroundSessionId: string | undefined
  let nextPendingInputId = 0

  function clearAwaitingAgentCheck(sessionId: string) {
    const timer = awaitingAgentTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    awaitingAgentTimers.delete(sessionId)
  }

  function checkAwaitingAgent(sessionId: string, runId: string | undefined) {
    clearAwaitingAgentCheck(sessionId)
    awaitingAgentTimers.set(sessionId, setTimeout(() => {
      awaitingAgentTimers.delete(sessionId)
      const activeRun = activeRuns.get(sessionId)
      if (!activeRun || activeRun.runId !== runId || useWorkspaceStore.getState().runs[sessionId]?.status !== 'awaiting_agent') return
      void runtime.getRuntimeState(sessionId).then((state) => {
        const current = activeRuns.get(sessionId)
        if (!current || current.runId !== runId || useWorkspaceStore.getState().runs[sessionId]?.status !== 'awaiting_agent') return
        useWorkspaceStore.getState().updateRun(sessionId, { waitingMessage: state.isStreaming ? 'Pi 正在处理，等待首个执行事件…' : '正在同步会话状态…' })
        if (!state.isStreaming) void invalidateHistory(sessionId)
      }).catch(() => undefined)
    }, 4_000))
  }

  function fail(sessionId: string, message: string) {
    clearAwaitingAgentCheck(sessionId)
    if (!activeRuns.delete(sessionId)) return
    useWorkspaceStore.getState().updateRun(sessionId, { error: message, status: 'error' })
    void invalidateHistory(sessionId)
  }

  function beginRun({ historyTurnCount, prompt, sessionId, startedAt }: StartSessionRunOptions, status: Extract<PromptStatus, 'awaiting_agent' | 'submitted' | 'running'> = 'submitted', awaitingRunId = false, runId?: string) {
    activeRuns.set(sessionId, { awaitingRunId, runId, stopReason: undefined })
    useWorkspaceStore.getState().setRun(sessionId, {
      status,
      systemEvents: [],
      pendingInputs: [],
      turns: [{ events: [], ...(historyTurnCount === undefined ? {} : { historyTurnCount }), id: `pending:${sessionId}`, prompt, startedAt: startedAt ?? new Date().toISOString() }],
    })
  }

  runtime.onPiEvent((event) => {
    let activeRun = activeRuns.get(event.sessionId)
    if (!activeRun && event.event.type === 'agent_start' && event.runId) {
      clearAwaitingAgentCheck(event.sessionId)
      activeRun = { awaitingRunId: false, runId: event.runId, stopReason: undefined }
      activeRuns.set(event.sessionId, activeRun)
      useWorkspaceStore.getState().promotePendingInput(event.sessionId, event.observedAt)
    }
    if (!activeRun) return
    if (activeRun.awaitingRunId || (activeRun.runId !== undefined && event.runId !== activeRun.runId)) return
    if (activeRun.runId === undefined && event.runId !== undefined) activeRun.runId = event.runId
    if (startsExecution(event)) {
      clearAwaitingAgentCheck(event.sessionId)
      if (Number.isFinite(Date.parse(event.observedAt))) useWorkspaceStore.getState().markRunExecutionStarted(event.sessionId, event.observedAt)
      useWorkspaceStore.getState().updateRun(event.sessionId, { status: 'running', waitingMessage: undefined })
    }
    if (isExtensionDialog(event)) useWorkspaceStore.getState().updateRun(event.sessionId, { status: 'awaiting_input', waitingMessage: undefined })
    const userInput = nativeUserMessage(event)
    if (userInput) useWorkspaceStore.getState().consumePendingInput(event.sessionId, userInput)
    useWorkspaceStore.getState().appendRunEvent(event.sessionId, event)
    activeRun.stopReason ??= assistantStopReason(event)
    if (event.event.type !== 'agent_settled') return

    clearAwaitingAgentCheck(event.sessionId)
    activeRuns.delete(event.sessionId)
    // Both timestamps are captured in this browser, so a completed duration never
    // switches to the daemon/history clock when the persisted entry arrives.
    useWorkspaceStore.getState().completeLatestRunTurn(event.sessionId, new Date().toISOString())
    useWorkspaceStore.getState().clearPendingInputs(event.sessionId)
    useWorkspaceStore.getState().updateRun(event.sessionId, {
      status: activeRun.stopReason === 'aborted' ? 'aborted' : 'complete',
      stopReason: activeRun.stopReason ?? 'stop',
    })
    void invalidateHistory(event.sessionId)
  })

  runtime.onError((error) => {
    if (error.code === 'RUNTIME_RESTARTED' && error.sessionId) {
      activeRuns.delete(error.sessionId)
      useWorkspaceStore.getState().updateRun(error.sessionId, { error: 'Pi 运行服务已重启，本轮已中断。', status: 'error' })
      useWorkspaceStore.getState().setWatchState(error.sessionId, 'watching')
      void invalidateHistory(error.sessionId)
      return
    }
    if (error.code === 'RESUME_GAP' && error.sessionId) {
      clearAwaitingAgentCheck(error.sessionId)
      activeRuns.delete(error.sessionId)
      useWorkspaceStore.getState().clearRun(error.sessionId)
      useWorkspaceStore.getState().setWatchState(error.sessionId, 'watching')
      void invalidateHistory(error.sessionId)
      return
    }
    const sessionIds = error.sessionId ? [error.sessionId] : [...activeRuns.keys()]
    for (const sessionId of sessionIds) fail(sessionId, error.message)
  })

  runtime.onResyncRequired((message) => {
    clearAwaitingAgentCheck(message.sessionId)
    activeRuns.delete(message.sessionId)
    useWorkspaceStore.getState().clearRun(message.sessionId)
    useWorkspaceStore.getState().setWatchState(message.sessionId, 'watching')
    void invalidateHistory(message.sessionId)
  })

  runtime.onSessionSnapshot((snapshot) => {
    useWorkspaceStore.getState().setWatchState(snapshot.sessionId, 'ready')
    if (snapshot.activeTurn && !activeRuns.has(snapshot.sessionId)) {
      const status = snapshot.activeTurn.waitingForExtension ? 'awaiting_input' : 'running'
      if (status === 'running' && snapshot.activeTurn.prompt) beginRun({ ...snapshot.activeTurn, prompt: snapshot.activeTurn.prompt, sessionId: snapshot.sessionId }, status, false, snapshot.activeTurn.runId)
      else {
        activeRuns.set(snapshot.sessionId, { awaitingRunId: false, runId: snapshot.activeTurn.runId, stopReason: undefined })
        useWorkspaceStore.getState().setRun(snapshot.sessionId, { pendingInputs: [], status, systemEvents: [], turns: [] })
      }
    }
  })

  runtime.onRuntimeStatus((status) => {
    if (status.lifecycle === 'active' && !activeRuns.has(status.sessionId)) {
      activeRuns.set(status.sessionId, { awaitingRunId: false, runId: undefined, stopReason: undefined })
      useWorkspaceStore.getState().setRun(status.sessionId, { pendingInputs: [], status: 'running', systemEvents: [], turns: [] })
    }
    if (status.lifecycle === 'failed') fail(status.sessionId, status.error ?? 'Pi runtime failed')
    if (status.lifecycle === 'idle' && runtime.watchedSessions().some((watch) => watch.sessionId === status.sessionId && watch.role === 'background')) {
      void runtime.unwatch(status.sessionId)
      void invalidateHistory(status.sessionId)
    }
  })

  return {
    adopt: (options) => {
      if (!activeRuns.has(options.sessionId)) {
        beginRun(options, 'awaiting_agent')
        checkAwaitingAgent(options.sessionId, undefined)
      }
    },
    compact: async (sessionId) => { await runtime.resumeRuntime(sessionId); await runtime.compact(sessionId) },
    followUp: async (sessionId, message) => {
      await runtime.followUp(sessionId, message)
      useWorkspaceStore.getState().appendPendingInput(sessionId, { id: `pending-input:${++nextPendingInputId}`, message, mode: 'follow_up', submittedAt: new Date().toISOString() })
    },
    getAvailableModels: async (sessionId) => (await runtime.getAvailableModels(sessionId)).models,
    getAvailableThinkingLevels: async (sessionId) => (await runtime.getAvailableThinkingLevels(sessionId)).levels,
    getRuntimeState: (sessionId) => runtime.getRuntimeState(sessionId),
    openSession: (sessionId) => {
      void (async () => {
        const previous = foregroundSessionId
        foregroundSessionId = sessionId
        useWorkspaceStore.getState().setWatchState(sessionId, 'watching')
        if (previous && previous !== sessionId) {
          const lifecycle = useWorkspaceStore.getState().runtimeStates[previous]?.lifecycle
          if (lifecycle === 'active' || lifecycle === 'loading') await runtime.watch(previous, 'background')
          else await runtime.unwatch(previous)
        }
        await runtime.watch(sessionId, 'foreground')
        useWorkspaceStore.getState().setWatchState(sessionId, 'ready')
      })().catch(() => undefined)
    },
    releaseForeground: () => {
      const sessionId = foregroundSessionId
      foregroundSessionId = undefined
      if (!sessionId) return
      const lifecycle = useWorkspaceStore.getState().runtimeStates[sessionId]?.lifecycle
      if (lifecycle === 'active' || lifecycle === 'loading') {
        void runtime.watch(sessionId, 'background')
      } else {
        void runtime.unwatch(sessionId)
      }
    },
    resume: () => {
      for (const watch of runtime.watchedSessions()) {
        if (watch.role === 'foreground') foregroundSessionId = watch.sessionId
        useWorkspaceStore.getState().setWatchState(watch.sessionId, 'watching')
        void runtime.watch(watch.sessionId, watch.role, watch.after).then(() => useWorkspaceStore.getState().setWatchState(watch.sessionId, 'ready')).catch((cause) => {
          if (!isRuntimeConnectionError(cause)) fail(watch.sessionId, cause instanceof Error ? cause.message : 'Pi session replay failed')
        })
      }
    },
    resumeRuntime: async (sessionId) => { await runtime.resumeRuntime(sessionId) },
    setModel: async (sessionId, provider, modelId) => { await runtime.resumeRuntime(sessionId); await runtime.setModel(sessionId, provider, modelId) },
    setThinkingLevel: async (sessionId, level) => { await runtime.resumeRuntime(sessionId); await runtime.setThinkingLevel(sessionId, level) },
    start: (options) => {
      const { prompt, sessionId } = options
      if (activeRuns.has(sessionId)) return false
      beginRun(options, 'submitted', true)
      void (async () => {
        try {
          useWorkspaceStore.getState().setWatchState(sessionId, 'watching')
          await runtime.watch(sessionId, 'foreground')
          useWorkspaceStore.getState().setWatchState(sessionId, 'ready')
          await runtime.resumeRuntime(sessionId)
          const accepted = await runtime.prompt(sessionId, prompt)
          const activeRun = activeRuns.get(sessionId)
          if (!activeRun || typeof accepted?.runId !== 'string') throw new Error('Pi runtime did not acknowledge this prompt')
          activeRun.awaitingRunId = false
          activeRun.runId = accepted.runId
          useWorkspaceStore.getState().updateRun(sessionId, { status: 'awaiting_agent' })
          checkAwaitingAgent(sessionId, accepted.runId)
        } catch (cause) {
          if (!isRuntimeConnectionError(cause)) fail(sessionId, cause instanceof Error ? cause.message : 'Pi session prompt failed')
        }
      })()
      return true
    },
    stop: async (sessionId) => {
      const previousStatus = useWorkspaceStore.getState().runs[sessionId]?.status
      if (!activeRuns.has(sessionId) || !previousStatus || !['submitted', 'awaiting_agent', 'running'].includes(previousStatus)) return false
      clearAwaitingAgentCheck(sessionId)
      useWorkspaceStore.getState().updateRun(sessionId, { error: undefined, status: 'aborting' })
      try {
        await runtime.abort(sessionId)
        return true
      } catch (cause) {
        if (activeRuns.has(sessionId)) {
          useWorkspaceStore.getState().updateRun(sessionId, {
            error: cause instanceof Error ? cause.message : 'Pi session could not be stopped', status: previousStatus,
          })
        }
        return false
      }
    },
    steer: async (sessionId, message) => {
      await runtime.steer(sessionId, message)
      useWorkspaceStore.getState().appendPendingInput(sessionId, { id: `pending-input:${++nextPendingInputId}`, message, mode: 'steer', submittedAt: new Date().toISOString() })
    },
  }
}
