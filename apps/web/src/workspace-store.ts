import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { NavigationOrder } from './navigation-order.js'

export type PromptStatus = 'idle' | 'running' | 'aborting' | 'aborted' | 'complete' | 'error'

export type SessionRunSummary = {
  error?: string
  model?: string
  responseText: string
  status: PromptStatus
  stopReason?: string
  textDeltaCount?: number
}

const unavailableStorage = {
  getItem: () => null,
  removeItem: () => undefined,
  setItem: () => undefined,
}

type WorkspaceState = {
  collapsedProjectKeys: Record<string, boolean>
  drafts: Record<string, string>
  inspectorOpen: boolean
  inspectorWidth: number
  navigationOpen: boolean
  navigationWidth: number
  appendRunDelta: (sessionId: string, delta: string) => void
  runs: Record<string, SessionRunSummary>
  navigationOrder: NavigationOrder
  setDraft: (sessionId: string, draft: string) => void
  setInspectorOpen: (open: boolean) => void
  setNavigationOpen: (open: boolean) => void
  setNavigationOrder: (order: NavigationOrder) => void
  setProjectCollapsed: (projectKey: string, collapsed: boolean) => void
  setRun: (sessionId: string, run: SessionRunSummary) => void
  updateRun: (sessionId: string, update: Partial<SessionRunSummary>) => void
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist((set) => ({
  collapsedProjectKeys: {},
  drafts: {},
  inspectorOpen: false,
  inspectorWidth: 300,
  navigationOpen: false,
  navigationWidth: 272,
  navigationOrder: { projectOrder: [], sessionOrderByProject: {} },
  runs: {},
  appendRunDelta: (sessionId, delta) =>
    set((state) => {
      const run = state.runs[sessionId]
      if (!run) return state

      return {
        runs: {
          ...state.runs,
          [sessionId]: {
            ...run,
            responseText: run.responseText + delta,
            textDeltaCount: (run.textDeltaCount ?? 0) + 1,
          },
        },
      }
    }),
  setDraft: (sessionId, draft) => set((state) => ({ drafts: { ...state.drafts, [sessionId]: draft } })),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setNavigationOpen: (navigationOpen) => set({ navigationOpen }),
  setNavigationOrder: (navigationOrder) => set({ navigationOrder }),
  setProjectCollapsed: (projectKey, collapsed) =>
    set((state) => ({ collapsedProjectKeys: { ...state.collapsedProjectKeys, [projectKey]: collapsed } })),
  setRun: (sessionId, run) => set((state) => ({ runs: { ...state.runs, [sessionId]: run } })),
  updateRun: (sessionId, update) =>
    set((state) => ({
      runs: {
        ...state.runs,
        [sessionId]: { ...state.runs[sessionId], responseText: '', status: 'idle', ...update },
      },
    })),
    }),
    {
      name: 'pi-nest-navigation-order',
      partialize: (state) => ({ navigationOrder: state.navigationOrder }),
      storage: createJSONStorage(() => (typeof window === 'undefined' ? unavailableStorage : window.localStorage)),
    },
  ),
)
