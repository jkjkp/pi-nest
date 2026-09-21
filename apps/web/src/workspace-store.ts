import { create } from 'zustand'

export type PromptStatus = 'idle' | 'running' | 'aborting' | 'aborted' | 'complete' | 'error'

export type SessionRunSummary = {
  error?: string
  model?: string
  responseText: string
  status: PromptStatus
  stopReason?: string
  textDeltaCount?: number
}

type WorkspaceState = {
  collapsedProjectKeys: Record<string, boolean>
  drafts: Record<string, string>
  inspectorOpen: boolean
  inspectorWidth: number
  navigationOpen: boolean
  navigationWidth: number
  appendRunDelta: (sessionId: string, delta: string) => void
  expandProject: (projectKey: string) => void
  runs: Record<string, SessionRunSummary>
  setDraft: (sessionId: string, draft: string) => void
  setInspectorOpen: (open: boolean) => void
  setNavigationOpen: (open: boolean) => void
  setRun: (sessionId: string, run: SessionRunSummary) => void
  toggleProjectCollapsed: (projectKey: string) => void
  updateRun: (sessionId: string, update: Partial<SessionRunSummary>) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  collapsedProjectKeys: {},
  drafts: {},
  inspectorOpen: false,
  inspectorWidth: 288,
  navigationOpen: false,
  navigationWidth: 272,
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
  expandProject: (projectKey) =>
    set((state) => {
      if (!state.collapsedProjectKeys[projectKey]) return state
      return { collapsedProjectKeys: { ...state.collapsedProjectKeys, [projectKey]: false } }
    }),
  setDraft: (sessionId, draft) => set((state) => ({ drafts: { ...state.drafts, [sessionId]: draft } })),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setNavigationOpen: (navigationOpen) => set({ navigationOpen }),
  setRun: (sessionId, run) => set((state) => ({ runs: { ...state.runs, [sessionId]: run } })),
  toggleProjectCollapsed: (projectKey) =>
    set((state) => ({
      collapsedProjectKeys: {
        ...state.collapsedProjectKeys,
        [projectKey]: !state.collapsedProjectKeys[projectKey],
      },
    })),
  updateRun: (sessionId, update) =>
    set((state) => ({
      runs: {
        ...state.runs,
        [sessionId]: { ...state.runs[sessionId], responseText: '', status: 'idle', ...update },
      },
    })),
}))
