import { isRuntimeConnectionError, RuntimeWebSocketClient, type PiRuntimeEvent, type PiRuntimeModel, type PiRuntimeState } from './runtime-websocket-client.js'
import { useWorkspaceStore } from './workspace-store.js'

type SessionRunControllerOptions = {
  invalidateHistory: (sessionId: string) => void | Promise<void>
  runtime: RuntimeWebSocketClient
}

type StartSessionRunOptions = { prompt: string; sessionId: string }
type ActiveRun = { stopReason: string | undefined }

export type SessionRunController = {
  compact: (sessionId: string) => Promise<void>
  followUp: (sessionId: string, message: string) => Promise<void>
  getAvailableModels: (sessionId: string) => Promise<PiRuntimeModel[]>
  getAvailableThinkingLevels: (sessionId: string) => Promise<string[]>
  getRuntimeState: (sessionId: string) => Promise<PiRuntimeState>
  resume: () => void
  setModel: (sessionId: string, provider: string, modelId: string) => Promise<void>
  setThinkingLevel: (sessionId: string, level: string) => Promise<void>
  start: (options: StartSessionRunOptions) => boolean
  steer: (sessionId: string, message: string) => Promise<void>
  stop: (sessionId: string) => Promise<boolean>
}

const recoveryKey = 'pi-nest-active-runtime-sessions'

function savedActiveSessions() {
  if (typeof window === 'undefined') return [] as string[]
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(recoveryKey) ?? '[]')
    return Array.isArray(saved) ? saved.filter((sessionId): sessionId is string => typeof sessionId === 'string') : []
  } catch {
    return []
  }
}

function saveActiveSessions(sessionIds: Iterable<string>) {
  try {
    if (typeof window !== 'undefined') window.sessionStorage.setItem(recoveryKey, JSON.stringify([...sessionIds]))
  } catch {
    // sessionStorage is only a recovery hint; Pi keeps running without it.
  }
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
  const save = () => saveActiveSessions(activeRuns.keys())

  function fail(sessionId: string, message: string) {
    if (!activeRuns.delete(sessionId)) return
    save()
    useWorkspaceStore.getState().updateRun(sessionId, { error: message, status: 'error' })
    void invalidateHistory(sessionId)
  }

  runtime.onPiEvent((event) => {
    const activeRun = activeRuns.get(event.sessionId)
    if (!activeRun) return
    useWorkspaceStore.getState().appendRunEvent(event.sessionId, event)
    activeRun.stopReason ??= assistantStopReason(event)
    if (event.event.type !== 'agent_settled') return

    activeRuns.delete(event.sessionId)
    save()
    useWorkspaceStore.getState().updateRun(event.sessionId, {
      status: activeRun.stopReason === 'aborted' ? 'aborted' : 'complete',
      stopReason: activeRun.stopReason ?? 'stop',
    })
    void invalidateHistory(event.sessionId)
  })

  runtime.onError((error) => {
    const sessionIds = error.sessionId ? [error.sessionId] : [...activeRuns.keys()]
    for (const sessionId of sessionIds) fail(sessionId, error.message)
  })

  return {
    compact: (sessionId) => runtime.compact(sessionId),
    followUp: (sessionId, message) => runtime.followUp(sessionId, message),
    getAvailableModels: async (sessionId) => (await runtime.getAvailableModels(sessionId)).models,
    getAvailableThinkingLevels: async (sessionId) => (await runtime.getAvailableThinkingLevels(sessionId)).levels,
    getRuntimeState: (sessionId) => runtime.getRuntimeState(sessionId),
    resume: () => {
      for (const sessionId of savedActiveSessions()) {
        if (activeRuns.has(sessionId)) continue
        activeRuns.set(sessionId, { stopReason: undefined })
        useWorkspaceStore.getState().setRun(sessionId, { status: 'running', systemEvents: [], turns: [] })
        void runtime.attach(sessionId, 0).catch((cause) => {
          if (!isRuntimeConnectionError(cause)) fail(sessionId, cause instanceof Error ? cause.message : 'Pi session replay failed')
        })
      }
      save()
    },
    setModel: (sessionId, provider, modelId) => runtime.setModel(sessionId, provider, modelId),
    setThinkingLevel: (sessionId, level) => runtime.setThinkingLevel(sessionId, level),
    start: ({ prompt, sessionId }) => {
      if (activeRuns.has(sessionId)) return false
      activeRuns.set(sessionId, { stopReason: undefined })
      save()
      useWorkspaceStore.getState().setRun(sessionId, {
        status: 'running',
        systemEvents: [],
        turns: [{ events: [], id: `pending:${sessionId}`, prompt, startedAt: new Date().toISOString() }],
      })
      void (async () => {
        try {
          await runtime.attach(sessionId)
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
