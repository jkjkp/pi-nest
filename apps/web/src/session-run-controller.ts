import { isRuntimeConnectionError, RuntimeWebSocketClient, type PiRuntimeEvent, type PiRuntimeModel, type PiRuntimeState } from './runtime-websocket-client.js'
import { useWorkspaceStore } from './workspace-store.js'

type SessionRunControllerOptions = {
  invalidateHistory: (sessionId: string) => void | Promise<void>
  runtime: RuntimeWebSocketClient
}

type StartSessionRunOptions = { historyTurnCount?: number; prompt: string; sessionId: string }
type ActiveRun = { stopReason: string | undefined }

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

export function createSessionRunController({ invalidateHistory, runtime }: SessionRunControllerOptions): SessionRunController {
  const activeRuns = new Map<string, ActiveRun>()
  let foregroundSessionId: string | undefined

  function fail(sessionId: string, message: string) {
    if (!activeRuns.delete(sessionId)) return
    useWorkspaceStore.getState().updateRun(sessionId, { error: message, status: 'error' })
    void invalidateHistory(sessionId)
  }

  function beginRun({ historyTurnCount, prompt, sessionId }: StartSessionRunOptions) {
    activeRuns.set(sessionId, { stopReason: undefined })
    useWorkspaceStore.getState().setRun(sessionId, {
      status: 'running',
      systemEvents: [],
      turns: [{ events: [], ...(historyTurnCount === undefined ? {} : { historyTurnCount }), id: `pending:${sessionId}`, prompt, startedAt: new Date().toISOString() }],
    })
  }

  runtime.onPiEvent((event) => {
    const activeRun = activeRuns.get(event.sessionId)
    if (!activeRun) return
    useWorkspaceStore.getState().appendRunEvent(event.sessionId, event)
    activeRun.stopReason ??= assistantStopReason(event)
    if (event.event.type !== 'agent_settled') return

    activeRuns.delete(event.sessionId)
    useWorkspaceStore.getState().updateRun(event.sessionId, {
      status: activeRun.stopReason === 'aborted' ? 'aborted' : 'complete',
      stopReason: activeRun.stopReason ?? 'stop',
    })
    void invalidateHistory(event.sessionId)
  })

  runtime.onError((error) => {
    if ((error.code === 'RESUME_GAP' || error.code === 'RUNTIME_RESTARTED') && error.sessionId) {
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
    activeRuns.delete(message.sessionId)
    useWorkspaceStore.getState().clearRun(message.sessionId)
    useWorkspaceStore.getState().setWatchState(message.sessionId, 'watching')
    void invalidateHistory(message.sessionId)
  })

  runtime.onSessionSnapshot((snapshot) => {
    useWorkspaceStore.getState().setWatchState(snapshot.sessionId, 'ready')
  })

  runtime.onRuntimeStatus((status) => {
    if (status.lifecycle === 'active' && !activeRuns.has(status.sessionId)) {
      activeRuns.set(status.sessionId, { stopReason: undefined })
      useWorkspaceStore.getState().setRun(status.sessionId, { status: 'running', systemEvents: [], turns: [] })
    }
    if (status.lifecycle === 'failed') fail(status.sessionId, status.error ?? 'Pi runtime failed')
    if (status.lifecycle === 'idle' && runtime.watchedSessions().some((watch) => watch.sessionId === status.sessionId && watch.role === 'background')) {
      void runtime.unwatch(status.sessionId)
      void invalidateHistory(status.sessionId)
    }
  })

  return {
    adopt: (options) => {
      if (!activeRuns.has(options.sessionId)) beginRun(options)
    },
    compact: async (sessionId) => { await runtime.resumeRuntime(sessionId); await runtime.compact(sessionId) },
    followUp: (sessionId, message) => runtime.followUp(sessionId, message),
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
      beginRun(options)
      void (async () => {
        try {
          useWorkspaceStore.getState().setWatchState(sessionId, 'watching')
          await runtime.watch(sessionId, 'foreground')
          useWorkspaceStore.getState().setWatchState(sessionId, 'ready')
          await runtime.resumeRuntime(sessionId)
          await runtime.prompt(sessionId, prompt)
        } catch (cause) {
          if (!isRuntimeConnectionError(cause)) fail(sessionId, cause instanceof Error ? cause.message : 'Pi session prompt failed')
        }
      })()
      return true
    },
    stop: async (sessionId) => {
      if (!activeRuns.has(sessionId) || useWorkspaceStore.getState().runs[sessionId]?.status !== 'running') return false
      useWorkspaceStore.getState().updateRun(sessionId, { error: undefined, status: 'aborting' })
      try {
        await runtime.abort(sessionId)
        return true
      } catch (cause) {
        if (activeRuns.has(sessionId)) {
          useWorkspaceStore.getState().updateRun(sessionId, {
            error: cause instanceof Error ? cause.message : 'Pi session could not be stopped', status: 'running',
          })
        }
        return false
      }
    },
    steer: (sessionId, message) => runtime.steer(sessionId, message),
  }
}
