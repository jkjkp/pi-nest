import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { NavigationOrder } from './navigation-order.js'
import type { RuntimeTurn } from './timeline-model.js'
import type { PiRuntimeEvent } from './runtime-websocket-client.js'

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
  extensionStatus: Record<string, string | undefined>
  extensionWidgets: Record<string, string[]>
  inspectorOpen: boolean
  inspectorWidth: number
  navigationOpen: boolean
  navigationWidth: number
  appendRunEvent: (sessionId: string, event: PiRuntimeEvent) => void
  runs: Record<string, SessionRunSummary>
  navigationOrder: NavigationOrder
  setDraft: (sessionId: string, draft: string) => void
  setExtensionStatus: (sessionId: string, status: string | undefined) => void
  setExtensionWidget: (sessionId: string, lines: string[]) => void
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
  extensionStatus: {},
  extensionWidgets: {},
  inspectorOpen: false,
  inspectorWidth: 300,
  navigationOpen: false,
  navigationWidth: 272,
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

      const existingIndex = run.turns.findIndex((turn) => turn.id === event.turnId)
      const pendingIndex = run.turns.findIndex((turn) => turn.id === `pending:${sessionId}`)
      const index = existingIndex >= 0 ? existingIndex : pendingIndex
      const turns = [...run.turns]
      if (index >= 0) {
        const current = turns[index]!
        turns[index] = { ...current, events: [...current.events, event], id: existingIndex >= 0 ? current.id : event.turnId }
      } else {
        turns.push({ events: [event], id: event.turnId, startedAt: event.observedAt })
      }

      return {
        runs: {
          ...state.runs,
          [sessionId]: { ...run, turns },
        },
      }
    }),
  setDraft: (sessionId, draft) => set((state) => ({ drafts: { ...state.drafts, [sessionId]: draft } })),
  setExtensionStatus: (sessionId, status) => set((state) => ({ extensionStatus: { ...state.extensionStatus, [sessionId]: status } })),
  setExtensionWidget: (sessionId, lines) => set((state) => ({ extensionWidgets: { ...state.extensionWidgets, [sessionId]: lines } })),
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
        [sessionId]: state.runs[sessionId]
          ? { ...state.runs[sessionId], ...update }
          : { status: 'idle', systemEvents: [], turns: [], ...update },
      },
    })),
    }),
    {
      name: 'pi-nest-navigation-order',
      partialize: (state) => ({ extensionStatus: state.extensionStatus, navigationOrder: state.navigationOrder }),
      storage: createJSONStorage(() => (typeof window === 'undefined' ? unavailableStorage : window.localStorage)),
    },
  ),
)
