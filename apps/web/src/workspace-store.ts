import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { NavigationOrder } from './navigation-order.js'
import type { RuntimeTurn } from './timeline-model.js'
import type { PiRuntimeEvent, RuntimeStatus } from './runtime-websocket-client.js'

export type PromptStatus = 'idle' | 'submitted' | 'awaiting_agent' | 'awaiting_input' | 'running' | 'aborting' | 'aborted' | 'complete' | 'error'
export type PendingInput = { id: string; message: string; mode: 'follow_up' | 'plan_implementation' | 'steer'; submittedAt: string }

export function isRunActive(status: PromptStatus) {
  return status === 'submitted' || status === 'awaiting_agent' || status === 'awaiting_input' || status === 'running' || status === 'aborting'
}

export function nativeUserMessage(event: PiRuntimeEvent) {
  if (event.event.type !== 'message' && event.event.type !== 'message_start') return undefined
  const message = event.event.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  const candidate = message as Record<string, unknown>
  if (candidate.role !== 'user') return undefined
  if (typeof candidate.content === 'string') return candidate.content
  if (!Array.isArray(candidate.content)) return undefined
  const text = candidate.content.flatMap((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return []
    const value = block as Record<string, unknown>
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('')
  return text || undefined
}

export type SessionRunSummary = {
  executionStartedAt?: string
  error?: string
  model?: string
  pendingInputs?: PendingInput[]
  status: PromptStatus
  stopReason?: string
  systemEvents: PiRuntimeEvent[]
  turns: RuntimeTurn[]
  waitingMessage?: string
}

const unavailableStorage = {
  getItem: () => null,
  removeItem: () => undefined,
  setItem: () => undefined,
}

type WorkspaceState = {
  collapsedProjectKeys: Record<string, boolean>
  drafts: Record<string, string>
  extensionStatuses: Record<string, Record<string, string>>
  extensionWidgets: Record<string, Record<string, string[]>>
  hiddenProjectCwds: Record<string, true>
  inspectorOpen: boolean
  inspectorWidth: number
  navigationOpen: boolean
  navigationWidth: number
  runtimeStates: Record<string, Omit<RuntimeStatus, 'sessionId'>>
  watchStates: Record<string, 'ready' | 'watching'>
  appendRunEvent: (sessionId: string, event: PiRuntimeEvent) => void
  appendPendingInput: (sessionId: string, input: PendingInput) => void
  completeLatestRunTurn: (sessionId: string, completedAt: string) => void
  consumePendingInput: (sessionId: string, message: string) => void
  clearPendingInputs: (sessionId: string) => void
  markRunExecutionStarted: (sessionId: string, startedAt: string) => void
  promotePendingInput: (sessionId: string, startedAt: string) => void
  removePendingInput: (sessionId: string, id: string) => void
  runs: Record<string, SessionRunSummary>
  navigationOrder: NavigationOrder
  setDraft: (sessionId: string, draft: string) => void
  clearExtensionUi: (sessionId: string) => void
  clearRun: (sessionId: string) => void
  replaceExtensionUi: (sessionId: string, projection: { statuses: Record<string, string>; widgets: Record<string, string[]> }) => void
  setExtensionStatus: (sessionId: string, key: string, status: string | undefined) => void
  setExtensionWidget: (sessionId: string, key: string, lines: string[] | undefined) => void
  setInspectorOpen: (open: boolean) => void
  hideProject: (cwd: string) => void
  setNavigationOpen: (open: boolean) => void
  setNavigationOrder: (order: NavigationOrder) => void
  setProjectCollapsed: (projectKey: string, collapsed: boolean) => void
  restoreProject: (cwd: string) => void
  setRun: (sessionId: string, run: SessionRunSummary) => void
  setRuntimeState: (sessionId: string, runtime: Omit<RuntimeStatus, 'sessionId'>) => void
  setWatchState: (sessionId: string, state: 'ready' | 'watching') => void
  updateRun: (sessionId: string, update: Partial<SessionRunSummary>) => void
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist((set) => ({
  collapsedProjectKeys: {},
  drafts: {},
  extensionStatuses: {},
  extensionWidgets: {},
  hiddenProjectCwds: {},
  inspectorOpen: false,
  inspectorWidth: 300,
  navigationOpen: false,
  navigationWidth: 272,
  runtimeStates: {},
  watchStates: {},
  navigationOrder: { projectOrder: [], sessionOrderByProject: {} },
  runs: {},
  appendPendingInput: (sessionId, input) => set((state) => {
    const run = state.runs[sessionId] ?? { pendingInputs: [], status: 'complete' as const, systemEvents: [], turns: [] }
    return {
      runs: {
        ...state.runs,
        [sessionId]: {
          ...run,
          error: undefined,
          pendingInputs: [...(run.pendingInputs ?? []), input],
          status: input.mode === 'plan_implementation' || isRunActive(run.status) ? run.status : 'awaiting_agent',
          waitingMessage: undefined,
        },
      },
    }
  }),
  appendRunEvent: (sessionId, event) =>
    set((state) => {
      const run = state.runs[sessionId]
      if (!run) return state

      const prompt = nativeUserMessage(event)
      if (!event.turnId) {
        if (prompt && !run.turns.at(-1)?.prompt?.trim()) {
          return {
            runs: {
              ...state.runs,
              [sessionId]: { ...run, turns: [...run.turns, { events: [event], id: `native:${sessionId}:${event.sequence}`, prompt, startedAt: run.executionStartedAt ?? event.observedAt }] },
            },
          }
        }
        return {
          runs: {
            ...state.runs,
            [sessionId]: { ...run, systemEvents: [...run.systemEvents, event] },
          },
        }
      }

      const current = run.turns.at(-1)
      if (!current?.prompt?.trim()) {
        if (prompt) {
          return {
            runs: {
              ...state.runs,
              [sessionId]: { ...run, turns: [...run.turns, { events: [event], id: `native:${sessionId}:${event.sequence}`, prompt, startedAt: run.executionStartedAt ?? event.observedAt }] },
            },
          }
        }
        return {
          runs: {
            ...state.runs,
            [sessionId]: { ...run, systemEvents: [...run.systemEvents, event] },
          },
        }
      }
      const turns = [...run.turns.slice(0, -1), { ...current, events: [...current.events, event] }]

      return {
        runs: {
          ...state.runs,
          [sessionId]: { ...run, turns },
        },
      }
    }),
  completeLatestRunTurn: (sessionId, completedAt) =>
    set((state) => {
      const run = state.runs[sessionId]
      const current = run?.turns.at(-1)
      if (!run || !current || current.completedAt) return state
      return {
        runs: {
          ...state.runs,
          [sessionId]: { ...run, turns: [...run.turns.slice(0, -1), { ...current, completedAt }] },
        },
      }
    }),
  consumePendingInput: (sessionId, message) => set((state) => {
    const run = state.runs[sessionId]
    const index = run?.pendingInputs?.findIndex((input) => input.message === message) ?? -1
    if (!run || index < 0) return state
    return { runs: { ...state.runs, [sessionId]: { ...run, pendingInputs: (run.pendingInputs ?? []).filter((_input, current) => current !== index) } } }
  }),
  clearPendingInputs: (sessionId) => set((state) => {
    const run = state.runs[sessionId]
    return !run || (run.pendingInputs?.length ?? 0) === 0 ? state : { runs: { ...state.runs, [sessionId]: { ...run, pendingInputs: [] } } }
  }),
  markRunExecutionStarted: (sessionId, startedAt) => set((state) => {
    const run = state.runs[sessionId]
    if (!run || run.executionStartedAt) return state
    const current = run.turns.at(-1)
    return {
      runs: {
        ...state.runs,
        [sessionId]: {
          ...run,
          executionStartedAt: startedAt,
          turns: current ? [...run.turns.slice(0, -1), { ...current, startedAt }] : run.turns,
        },
      },
    }
  }),
  promotePendingInput: (sessionId, startedAt) => set((state) => {
    const run = state.runs[sessionId]
    const input = [...(run?.pendingInputs ?? [])].reverse().find((candidate) => candidate.mode === 'plan_implementation')
    if (!run || !input) return state
    return {
      runs: {
        ...state.runs,
        [sessionId]: {
          ...run,
          executionStartedAt: undefined,
          pendingInputs: (run.pendingInputs ?? []).filter((candidate) => candidate.id !== input.id),
          stopReason: undefined,
          turns: [...run.turns, { events: [], id: input.id, prompt: input.message, startedAt }],
        },
      },
    }
  }),
  removePendingInput: (sessionId, id) => set((state) => {
    const run = state.runs[sessionId]
    if (!run || !(run.pendingInputs ?? []).some((input) => input.id === id)) return state
    const pendingInputs = (run.pendingInputs ?? []).filter((input) => input.id !== id)
    const status = pendingInputs.length === 0 && run.status === 'awaiting_agent' && run.turns.at(-1)?.completedAt ? 'complete' : run.status
    return { runs: { ...state.runs, [sessionId]: { ...run, pendingInputs, status } } }
  }),
  setDraft: (sessionId, draft) => set((state) => ({ drafts: { ...state.drafts, [sessionId]: draft } })),
  clearExtensionUi: (sessionId) => set((state) => ({
    extensionStatuses: { ...state.extensionStatuses, [sessionId]: {} },
    extensionWidgets: { ...state.extensionWidgets, [sessionId]: {} },
  })),
  clearRun: (sessionId) => set((state) => {
    const { [sessionId]: _removed, ...runs } = state.runs
    return { runs }
  }),
  replaceExtensionUi: (sessionId, projection) => set((state) => ({
    extensionStatuses: { ...state.extensionStatuses, [sessionId]: { ...projection.statuses } },
    extensionWidgets: { ...state.extensionWidgets, [sessionId]: Object.fromEntries(Object.entries(projection.widgets).map(([key, lines]) => [key, [...lines]])) },
  })),
  setExtensionStatus: (sessionId, key, status) => set((state) => {
    if (!key) return state
    const statuses = { ...(state.extensionStatuses[sessionId] ?? {}) }
    if (typeof status === 'string') statuses[key] = status
    else delete statuses[key]
    return { extensionStatuses: { ...state.extensionStatuses, [sessionId]: statuses } }
  }),
  setExtensionWidget: (sessionId, key, lines) => set((state) => {
    if (!key) return state
    const widgets = { ...(state.extensionWidgets[sessionId] ?? {}) }
    if (lines) widgets[key] = [...lines]
    else delete widgets[key]
    return { extensionWidgets: { ...state.extensionWidgets, [sessionId]: widgets } }
  }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  hideProject: (cwd) => set((state) => ({ hiddenProjectCwds: { ...state.hiddenProjectCwds, [cwd]: true } })),
  setNavigationOpen: (navigationOpen) => set({ navigationOpen }),
  setNavigationOrder: (navigationOrder) => set({ navigationOrder }),
  setProjectCollapsed: (projectKey, collapsed) =>
    set((state) => ({ collapsedProjectKeys: { ...state.collapsedProjectKeys, [projectKey]: collapsed } })),
  restoreProject: (cwd) => set((state) => {
    const { [cwd]: _hidden, ...hiddenProjectCwds } = state.hiddenProjectCwds
    return { hiddenProjectCwds }
  }),
  setRun: (sessionId, run) => set((state) => ({ runs: { ...state.runs, [sessionId]: run } })),
  setRuntimeState: (sessionId, runtime) => set((state) => {
    const current = state.runtimeStates[sessionId]
    if (current && runtime.revision < current.revision) return state
    return { runtimeStates: { ...state.runtimeStates, [sessionId]: { ...runtime } } }
  }),
  setWatchState: (sessionId, watchState) => set((state) => ({ watchStates: { ...state.watchStates, [sessionId]: watchState } })),
  updateRun: (sessionId, update) =>
    set((state) => ({
      runs: {
        ...state.runs,
        [sessionId]: state.runs[sessionId]
          ? { ...state.runs[sessionId], ...update }
          : { pendingInputs: [], status: 'idle', systemEvents: [], turns: [], ...update },
      },
    })),
    }),
    {
      name: 'pi-nest-navigation-order',
      partialize: (state) => ({ hiddenProjectCwds: state.hiddenProjectCwds, navigationOrder: state.navigationOrder }),
      storage: createJSONStorage(() => (typeof window === 'undefined' ? unavailableStorage : window.localStorage)),
    },
  ),
)
