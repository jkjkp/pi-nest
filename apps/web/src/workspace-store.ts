import { create } from 'zustand'

export type PromptStatus = 'idle' | 'running' | 'aborting' | 'aborted' | 'complete' | 'error'

export type SessionRunSummary = {
  error?: string
  model?: string
  responseText: string
  status: PromptStatus
}

type WorkspaceState = {
  drafts: Record<string, string>
  inspectorOpen: boolean
  inspectorWidth: number
  navigationOpen: boolean
  navigationWidth: number
  runs: Record<string, SessionRunSummary>
  setDraft: (sessionId: string, draft: string) => void
  setInspectorOpen: (open: boolean) => void
  setNavigationOpen: (open: boolean) => void
  setRun: (sessionId: string, run: SessionRunSummary) => void
  updateRun: (sessionId: string, update: Partial<SessionRunSummary>) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  drafts: {},
  inspectorOpen: false,
  inspectorWidth: 288,
  navigationOpen: false,
  navigationWidth: 272,
  runs: {},
  setDraft: (sessionId, draft) => set((state) => ({ drafts: { ...state.drafts, [sessionId]: draft } })),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setNavigationOpen: (navigationOpen) => set({ navigationOpen }),
  setRun: (sessionId, run) => set((state) => ({ runs: { ...state.runs, [sessionId]: run } })),
  updateRun: (sessionId, update) =>
    set((state) => ({
      runs: {
        ...state.runs,
        [sessionId]: { ...state.runs[sessionId], responseText: '', status: 'idle', ...update },
      },
    })),
}))
