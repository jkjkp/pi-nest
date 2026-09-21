import { readSse, type ServerSentEvent } from './read-sse.js'
import { useWorkspaceStore } from './workspace-store.js'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type ReadSseFn = (response: Response, onEvent: (event: ServerSentEvent) => Promise<void> | void) => Promise<void>

type SessionRunControllerOptions = {
  fetchFn?: FetchFn
  invalidateHistory: (sessionId: string) => void | Promise<void>
  readSseFn?: ReadSseFn
}

type StartSessionRunOptions = {
  prompt: string
  sessionId: string
}

type ActiveRun = { controller: AbortController }

export type SessionRunController = {
  start: (options: StartSessionRunOptions) => boolean
  stop: (sessionId: string) => Promise<boolean>
}

type PromptEvent = {
  delta?: string
  message?: string
  model?: { id: string; provider: string }
  stopReason?: string
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback
}

export function createSessionRunController({
  fetchFn = fetch,
  invalidateHistory,
  readSseFn = readSse,
}: SessionRunControllerOptions): SessionRunController {
  const activeRuns = new Map<string, ActiveRun>()

  const run = async (sessionId: string, prompt: string, activeRun: ActiveRun) => {
    let terminalEvent = false

    try {
      const response = await fetchFn(`/api/sessions/${encodeURIComponent(sessionId)}/prompts`, {
        body: JSON.stringify({ prompt }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: activeRun.controller.signal,
      })

      await readSseFn(response, ({ data, event }) => {
        const payload = JSON.parse(data) as PromptEvent

        if (event === 'text_delta' && typeof payload.delta === 'string') {
          useWorkspaceStore.getState().appendRunDelta(sessionId, payload.delta)
          return
        }

        if (event === 'complete') {
          terminalEvent = true
          useWorkspaceStore.getState().updateRun(sessionId, {
            model: payload.model && `${payload.model.provider}/${payload.model.id}`,
            status: payload.stopReason === 'aborted' ? 'aborted' : 'complete',
            stopReason: payload.stopReason,
          })
          return
        }

        if (event === 'error') {
          terminalEvent = true
          throw new Error(payload.message ?? 'Pi session prompt failed')
        }
      })

      if (!terminalEvent) throw new Error('Pi session stream ended without a result')
    } catch (cause) {
      useWorkspaceStore.getState().updateRun(sessionId, {
        error: errorMessage(cause, 'Pi session prompt failed'),
        status: 'error',
      })
    } finally {
      if (activeRuns.get(sessionId) === activeRun) activeRuns.delete(sessionId)
      void invalidateHistory(sessionId)
    }
  }

  return {
    start: ({ prompt, sessionId }) => {
      if (activeRuns.has(sessionId)) return false

      const activeRun = { controller: new AbortController() }
      activeRuns.set(sessionId, activeRun)
      useWorkspaceStore.getState().setRun(sessionId, { responseText: '', status: 'running', textDeltaCount: 0 })
      void run(sessionId, prompt, activeRun)
      return true
    },
    stop: async (sessionId) => {
      const activeRun = activeRuns.get(sessionId)
      if (!activeRun || useWorkspaceStore.getState().runs[sessionId]?.status !== 'running') return false

      useWorkspaceStore.getState().updateRun(sessionId, { error: undefined, status: 'aborting' })
      try {
        const response = await fetchFn(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' })
        if (response.status !== 202) throw new Error('Pi session could not be stopped')
        return true
      } catch (cause) {
        if (activeRuns.get(sessionId) === activeRun) {
          useWorkspaceStore.getState().updateRun(sessionId, {
            error: errorMessage(cause, 'Pi session could not be stopped'),
            status: 'running',
          })
        }
        return false
      }
    },
  }
}
