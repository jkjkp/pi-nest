import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { NavigationOrder } from './navigation-order.js'
import type { RuntimeTurn } from './timeline-model.js'
import type { PiRuntimeEvent, RuntimeStatus } from './runtime-websocket-client.js'

export type PromptStatus = 'idle' | 'running' | 'aborting' | 'aborted' | 'complete' | 'error'

export type SessionRunSummary = {
  error?: string
  model?: string
  status: PromptStatus
  stopReason?: string
  systemEvents: PiRuntimeEvent[]
  turns: RuntimeTurn[]
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
  appendRunEvent: (sessionId, event) =>
    set((state) => {
      const run = state.runs[sessionId]
      if (!run) return state

      if (!event.turnId) {
        return {
          runs: {
            ...state.runs,
            [sessionId]: { ...run, systemEvents: [...run.systemEvents, event] },
          },
        }
      }

      const current = run.turns.at(-1)
      if (!current?.prompt?.trim()) {
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
          : { status: 'idle', systemEvents: [], turns: [], ...update },
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
