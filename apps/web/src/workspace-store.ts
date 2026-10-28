import { clampSidebarWidth } from './sidebar-width.js'
import { create, type StateCreator } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { FilePreviewSelection, FileReadingPosition } from './file-preview-state.js'
import type { NavigationOrder } from './navigation-order.js'
import { activeRuntimeTurn, isRunActive, nativeUserMessage, runtimeEventOwner, runtimeTurnAcceptsEvent, type PendingInput, type SessionRunSummary } from './session-run-model.js'
import type { PiRuntimeStatistics, PiRuntimeEvent, PiRuntimeState, RuntimeStatus } from '@pi-nest/contracts'

export { isRunActive, nativeUserMessage } from './session-run-model.js'
export type { PromptStatus, PendingInput, SessionRunSummary } from './session-run-model.js'

const unavailableStorage = {
  getItem: () => null,
  removeItem: () => undefined,
  setItem: () => undefined,
}

export type RuntimeStatisticsState = { data?: PiRuntimeStatistics; error?: string; loading?: boolean }

type SessionNotification = { pendingRunId?: string; completedRunId?: string; readRunId?: string }

// Keep runtime, queue and notification writes in SessionRunController so recovery shares the live event path.
type WorkspaceState = {
  filePreviews: Record<string, FilePreviewSelection>
  fileReadingPositions: Record<string, FileReadingPosition>
  openFilePreview: (sessionId: string, path: string, line?: number, searchRoot?: string) => void
  setFilePreviewOpen: (sessionId: string, open: boolean) => void
  rememberFilePosition: (key: string, position: FileReadingPosition) => void
  clearFilePreview: (sessionId: string) => void
  sessionNotifications: Record<string, SessionNotification>
  trackPendingRun: (sessionId: string, runId: string) => void
  finishNotification: (sessionId: string, runId: string, unread: boolean, successful: boolean) => void
  markSessionRead: (sessionId: string, runId: string) => void
  removeSessionNotification: (sessionId: string) => void
  navigationView: 'list' | 'tree'
  setNavigationView: (view: 'list' | 'tree') => void
  collapsedSessionIds: Record<string, boolean>
  setSessionCollapsed: (id: string, collapsed: boolean) => void
  expandSessionAncestors: (ids: string[]) => void
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
  runtimeStatistics: Record<string, RuntimeStatisticsState>
  setRuntimeStatistics: (sessionId: string, statistics: RuntimeStatisticsState) => void
  runtimeDetails: Record<string, PiRuntimeState>
  setRuntimeDetails: (sessionId: string, details: PiRuntimeState) => void
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
  setInspectorWidth: (width: number) => void
  hideProject: (cwd: string) => void
  setNavigationOpen: (open: boolean) => void
  setNavigationWidth: (width: number) => void
  setNavigationOrder: (order: NavigationOrder) => void
  setProjectCollapsed: (projectKey: string, collapsed: boolean) => void
  restoreProject: (cwd: string) => void
  setRun: (sessionId: string, run: SessionRunSummary) => void
  clearRuntimeState: (sessionId: string) => void
  setRuntimeState: (sessionId: string, runtime: Omit<RuntimeStatus, 'sessionId'>) => void
  setWatchState: (sessionId: string, state: 'ready' | 'watching') => void
  updateRun: (sessionId: string, update: Partial<SessionRunSummary>) => void
}

export const createWorkspaceState: StateCreator<WorkspaceState> = (set) => ({
  filePreviews: {},
  fileReadingPositions: {},
  openFilePreview: (sessionId, path, line, searchRoot) => set((state) => ({ filePreviews: { ...state.filePreviews, [sessionId]: { path, line, searchRoot, open: true, navigation: (state.filePreviews[sessionId]?.navigation ?? 0) + 1 } } })),
  setFilePreviewOpen: (sessionId, open) => set((state) => {
    const preview = state.filePreviews[sessionId]
    return preview ? { filePreviews: { ...state.filePreviews, [sessionId]: { ...preview, open } } } : state
  }),
  rememberFilePosition: (key, position) => set((state) => ({ fileReadingPositions: { ...state.fileReadingPositions, [key]: position } })),
  clearFilePreview: (sessionId) => set((state) => ({
    filePreviews: Object.fromEntries(Object.entries(state.filePreviews).filter(([id]) => id !== sessionId)),
    fileReadingPositions: Object.fromEntries(Object.entries(state.fileReadingPositions).filter(([key]) => JSON.parse(key)[0] !== sessionId)),
  })),
  sessionNotifications: {},
  trackPendingRun: (sessionId, runId) => set((state) => {
    const current = state.sessionNotifications[sessionId] ?? {}
    if (current.completedRunId === runId || current.pendingRunId === runId) return state
    return { sessionNotifications: { ...state.sessionNotifications, [sessionId]: { ...current, pendingRunId: runId } } }
  }),
  finishNotification: (sessionId, runId, unread, successful) => set((state) => {
    const current = state.sessionNotifications[sessionId] ?? {}
    if (current.pendingRunId !== runId) return state
    return { sessionNotifications: { ...state.sessionNotifications, [sessionId]: {
      ...current, pendingRunId: undefined,
      ...(successful ? { completedRunId: runId, readRunId: unread ? current.readRunId : runId } : {}),
    } } }
  }),
  markSessionRead: (sessionId, runId) => set((state) => {
    const current = state.sessionNotifications[sessionId]
    if (!current || current.completedRunId !== runId || current.readRunId === runId) return state
    return { sessionNotifications: { ...state.sessionNotifications, [sessionId]: { ...current, readRunId: runId } } }
  }),
  removeSessionNotification: (sessionId) => set((state) => {
    const { [sessionId]: _removed, ...sessionNotifications } = state.sessionNotifications
    return { sessionNotifications }
  }),
  navigationView: 'list',
  setNavigationView: (navigationView) => set({ navigationView }),
  collapsedSessionIds: {},
  setSessionCollapsed: (id, collapsed) => set((state) => ({ collapsedSessionIds: { ...state.collapsedSessionIds, [id]: collapsed } })),
  expandSessionAncestors: (ids) => set((state) => ids.every((id) => state.collapsedSessionIds[id] === false) ? state : ({ collapsedSessionIds: { ...state.collapsedSessionIds, ...Object.fromEntries(ids.map((id) => [id, false])) } })),
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
  runtimeStatistics: {},
  setRuntimeStatistics: (sessionId, statistics) => set((state) => ({ runtimeStatistics: { ...state.runtimeStatistics, [sessionId]: statistics } })),
  runtimeDetails: {},
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
      const active = activeRuntimeTurn(run.turns)
      const owner = runtimeEventOwner(run.turns, event)
      const activeAccepts = active && !active.completedAt && runtimeTurnAcceptsEvent(active, event, run.turns)
      const steeringIndex = owner < 0 && prompt ? run.turns.findIndex((turn) => runtimeTurnAcceptsEvent(turn, event, run.turns) && turn.prompt === prompt && turn.steering && ['sending', 'accepted', 'unknown'].includes(turn.steering.status)) : -1
      if (steeringIndex >= 0) {
        const turns = run.turns.map((turn, index) => index === steeringIndex ? { ...turn, runId: turn.runId ?? event.runId, events: [...turn.events, event], steering: { ...turn.steering!, status: 'applied' as const } } : turn)
        return { runs: { ...state.runs, [sessionId]: { ...run, turns } } }
      }
      if (owner >= 0 || (activeAccepts && run.turns.some((turn) => turn.steering))) {
        const target = owner >= 0 ? owner : run.turns.indexOf(active!)
        if (prompt && owner < 0 && prompt !== active?.prompt) {
          return { runs: { ...state.runs, [sessionId]: { ...run, turns: [...run.turns, { runId: event.runId, events: [event], id: `native:${sessionId}:${event.sequence}`, prompt, startedAt: event.observedAt, executionStartedAt: run.executionStartedAt }] } } }
        }
        const turns = run.turns.map((turn, index) => index === target ? { ...turn, runId: turn.runId ?? event.runId, events: [...turn.events, event] } : turn)
        return { runs: { ...state.runs, [sessionId]: { ...run, turns } } }
      }
      if (!event.turnId && !(event.runId && prompt)) {
        if (prompt && (!run.turns.at(-1)?.prompt?.trim() || run.turns.at(-1)?.completedAt || !runtimeTurnAcceptsEvent(run.turns.at(-1)!, event, run.turns))) {
          return {
            runs: {
              ...state.runs,
              [sessionId]: { ...run, turns: [...run.turns, { runId: event.runId, events: [event], id: `native:${sessionId}:${event.sequence}`, prompt, startedAt: run.executionStartedAt ?? event.observedAt }] },
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
      if (current && (current.completedAt || !runtimeTurnAcceptsEvent(current, event, run.turns)) && !prompt) {
        return { runs: { ...state.runs, [sessionId]: { ...run, systemEvents: [...run.systemEvents, event] } } }
      }
      if (!current?.prompt?.trim() || (prompt && current.completedAt) || !runtimeTurnAcceptsEvent(current, event, run.turns)) {
        if (prompt) {
          return {
            runs: {
              ...state.runs,
              [sessionId]: { ...run, turns: [...run.turns, { runId: event.runId, events: [event], id: `native:${sessionId}:${event.sequence}`, prompt, startedAt: run.executionStartedAt ?? event.observedAt }] },
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
      const turns = [...run.turns.slice(0, -1), { ...current, runId: current.runId ?? event.runId, events: [...current.events, event] }]

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
      const current = run && activeRuntimeTurn(run.turns)
      if (!run || !current || current.completedAt) return state
      return {
        runs: {
          ...state.runs,
          [sessionId]: { ...run, turns: run.turns.map((turn) => !turn.completedAt && (!turn.steering || turn.steering.status === 'applied') ? { ...turn, completedAt } : turn) },
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
    const current = activeRuntimeTurn(run.turns)
    return {
      runs: {
        ...state.runs,
        [sessionId]: {
          ...run,
          executionStartedAt: startedAt,
          turns: current && !current.completedAt ? run.turns.map((turn) => turn === current ? { ...turn, submittedAt: turn.submittedAt ?? turn.startedAt, startedAt } : turn) : run.turns,
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
  setInspectorWidth: (width) => set({ inspectorWidth: Number.isFinite(width) ? Math.max(240, width) : 300 }),
  hideProject: (cwd) => set((state) => ({ hiddenProjectCwds: { ...state.hiddenProjectCwds, [cwd]: true } })),
  setNavigationWidth: (width) => set({ navigationWidth: clampSidebarWidth(width, Infinity, 'navigation') }),
  setNavigationOpen: (navigationOpen) => set({ navigationOpen }),
  setNavigationOrder: (navigationOrder) => set({ navigationOrder }),
  setProjectCollapsed: (projectKey, collapsed) =>
    set((state) => ({ collapsedProjectKeys: { ...state.collapsedProjectKeys, [projectKey]: collapsed } })),
  restoreProject: (cwd) => set((state) => {
    const { [cwd]: _hidden, ...hiddenProjectCwds } = state.hiddenProjectCwds
    return { hiddenProjectCwds }
  }),
  setRun: (sessionId, run) => set((state) => ({ runs: { ...state.runs, [sessionId]: run } })),
  clearRuntimeState: (sessionId) => set((state) => {
    const { [sessionId]: _runtime, ...runtimeStates } = state.runtimeStates
    const { [sessionId]: _details, ...runtimeDetails } = state.runtimeDetails
    const { [sessionId]: _statistics, ...runtimeStatistics } = state.runtimeStatistics
    return { runtimeStates, runtimeDetails, runtimeStatistics }
  }),
  setRuntimeDetails: (sessionId, details) => set((state) => ({ runtimeDetails: { ...state.runtimeDetails, [sessionId]: { ...details, model: details.model ? { ...details.model } : undefined } } })),
  setRuntimeState: (sessionId, runtime) => set((state) => {
    const current = state.runtimeStates[sessionId]
    if (current && runtime.revision < current.revision) return state
    const runtimeDetails = { ...state.runtimeDetails }
    if (runtime.lifecycle === 'notLoaded' || runtime.lifecycle === 'failed') delete runtimeDetails[sessionId]
    return { runtimeStates: { ...state.runtimeStates, [sessionId]: { ...runtime } }, runtimeDetails }
  }),
  setWatchState: (sessionId, watchState) => set((state) => ({ watchStates: { ...state.watchStates, [sessionId]: watchState } })),
  updateRun: (sessionId, update) =>
    set((state) => {
      const current = state.runs[sessionId]
      if (current && Object.entries(update).every(([key, value]) => Object.is(current[key as keyof typeof current], value))) return state
      return {
        runs: {
          ...state.runs,
          [sessionId]: current
            ? { ...current, ...update }
            : { pendingInputs: [], status: 'idle', systemEvents: [], turns: [], ...update },
        },
      }
    }),
})

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(createWorkspaceState,
    {
      name: 'pi-nest-navigation-order',
      partialize: (state) => ({ navigationWidth: state.navigationWidth, navigationView: state.navigationView, collapsedSessionIds: state.collapsedSessionIds, inspectorWidth: state.inspectorWidth, sessionNotifications: state.sessionNotifications, hiddenProjectCwds: state.hiddenProjectCwds, navigationOrder: state.navigationOrder }),
      storage: createJSONStorage(() => (typeof window === 'undefined' ? unavailableStorage : window.localStorage)),
    },
  ),
)
