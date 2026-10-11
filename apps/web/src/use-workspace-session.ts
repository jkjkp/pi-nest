import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { historyUserTurnCount, mergeSessionHistoryPage, mergeSessionHistoryPages, sessionHistoryQueryKey, sessionTurnIndexQueryKey, type PiSessionHistoryResponse } from './history.js'
import { applyNavigationOrder, navigationOrdersEqual, reconcileNavigationOrder } from './navigation-order.js'
import type { SessionRunController } from './session-run-controller.js'
import { isRunActive } from './session-run-model.js'
import { useWorkspaceStore } from './workspace-store.js'
import { createSession, deleteSession, fetchSessionHistory, fetchSessionTurnIndex, fetchSessions, renameSession, revealProjectInFinder } from './workspace-api.js'
import { extensionStatusLine, extensionWidgetText, groupSessionsByProject, runtimeStatusLabel, type ProjectSessionGroup } from './workspace.js'

const emptySessions: Awaited<ReturnType<typeof fetchSessions>> = []
type HistoryPageParam = { before?: string; revision?: string }

export function useWorkspaceSession(sessionRuns: SessionRunController) {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const selectedSessionId = searchParams.get('session') ?? ''
  const draftProjectKey = searchParams.get('draftProject') ?? ''
  const drafts = useWorkspaceStore((state) => state.drafts)
  const extensionStatuses = useWorkspaceStore((state) => state.extensionStatuses)
  const extensionWidgets = useWorkspaceStore((state) => state.extensionWidgets)
  const collapsedProjectKeys = useWorkspaceStore((state) => state.collapsedProjectKeys)
  const hiddenProjectCwds = useWorkspaceStore((state) => state.hiddenProjectCwds)
  const runs = useWorkspaceStore((state) => state.runs)
  const runtimeStates = useWorkspaceStore((state) => state.runtimeStates)
  const watchStates = useWorkspaceStore((state) => state.watchStates)
  const setDraft = useWorkspaceStore((state) => state.setDraft)
  const navigationOrder = useWorkspaceStore((state) => state.navigationOrder)
  const hideProject = useWorkspaceStore((state) => state.hideProject)
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  const setNavigationOrder = useWorkspaceStore((state) => state.setNavigationOrder)
  const setProjectCollapsed = useWorkspaceStore((state) => state.setProjectCollapsed)
  const restoreProject = useWorkspaceStore((state) => state.restoreProject)
  const [mutatingSessionId, setMutatingSessionId] = useState<string>()
  const [controlError, setControlError] = useState<string>()
  const [draftError, setDraftError] = useState<string>()
  const [draftPrompt, setDraftPrompt] = useState('')
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [models, setModels] = useState<{ id: string; name?: string; provider: string }[]>([])
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([])
  const [queueMode, setQueueMode] = useState<'follow_up' | 'steer'>('steer')
  const [pendingJump, setPendingJump] = useState<{ sessionId: string; turnId: string }>()
  const selectedSessionIdRef = useRef(selectedSessionId)
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const sessions = sessionsQuery.data ?? emptySessions
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
  const currentRun = selectedSessionId ? runs[selectedSessionId] : undefined
  const activeTurn = currentRun?.turns.at(-1)
  const modelLabel = currentRun?.model ?? '当前模型不可用'
  const status = currentRun?.status ?? 'idle'
  const isActive = isRunActive(status)
  const isStreaming = status === 'running' || status === 'aborting'
  const extensionStatus = extensionStatusLine(extensionStatuses[selectedSessionId])
  const extensionWidget = extensionWidgetText(extensionWidgets[selectedSessionId])
  const runtimeStatus = runtimeStatusLabel(runtimeStates[selectedSessionId], isActive)
  const historyEnabled = Boolean(selectedSession) && watchStates[selectedSessionId] === 'ready' && !isStreaming && runtimeStates[selectedSessionId]?.lifecycle !== 'loading' && (runtimeStates[selectedSessionId]?.lifecycle !== 'active' || status === 'awaiting_input')
  const historyQuery = useInfiniteQuery<PiSessionHistoryResponse, Error, InfiniteData<PiSessionHistoryResponse>, ReturnType<typeof sessionHistoryQueryKey>, HistoryPageParam>({
    enabled: historyEnabled,
    getNextPageParam: () => undefined,
    getPreviousPageParam: (firstPage) => firstPage.hasEarlier ? { before: firstPage.beforeCursor, revision: firstPage.revision } : undefined,
    initialPageParam: {},
    queryKey: sessionHistoryQueryKey(selectedSessionId),
    queryFn: ({ pageParam }) => fetchSessionHistory(selectedSessionId, pageParam.before, pageParam.revision),
    retry: false,
  })
  const history = useMemo(() => mergeSessionHistoryPages(historyQuery.data?.pages), [historyQuery.data?.pages])
  const turnIndexQuery = useQuery({ enabled: historyEnabled && Boolean(history?.revision), queryKey: sessionTurnIndexQueryKey(selectedSessionId, history?.revision), queryFn: () => fetchSessionTurnIndex(selectedSessionId, history!.revision), retry: false })
  const historyTurnCount = historyUserTurnCount(history?.entries)

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId
  }, [selectedSessionId])

  const sourceProjects = useMemo(() => groupSessionsByProject(sessions), [sessions])
  const orderedProjects = useMemo(() => applyNavigationOrder(sourceProjects, navigationOrder), [navigationOrder, sourceProjects])
  const projects = useMemo(() => orderedProjects.filter((project) => !project.cwd || !hiddenProjectCwds[project.cwd]), [hiddenProjectCwds, orderedProjects])
  const removedProjects = useMemo(() => orderedProjects.filter((project) => Boolean(project.cwd && hiddenProjectCwds[project.cwd])), [hiddenProjectCwds, orderedProjects])
  const draftProject = !selectedSessionId ? projects.find((project) => project.key === draftProjectKey) : undefined
  const isDraft = Boolean(draftProject)
  const prompt = isDraft ? draftPrompt : drafts[selectedSessionId] ?? ''

  useEffect(() => {
    if (isDraft || sessions.length === 0) return
    const visibleSessions = projects.flatMap((project) => project.sessions)
    if (visibleSessions.some((session) => session.id === selectedSessionId)) return
    const fallback = visibleSessions[0]
    setSearchParams(fallback ? { session: fallback.id } : {}, { replace: true })
  }, [isDraft, projects, selectedSessionId, sessions.length, setSearchParams])

  useEffect(() => {
    const reconciled = reconcileNavigationOrder(navigationOrder, sourceProjects)
    if (!navigationOrdersEqual(navigationOrder, reconciled)) setNavigationOrder(reconciled)
  }, [navigationOrder, setNavigationOrder, sourceProjects])

  useEffect(() => {
    if (!selectedSession) return
    sessionRuns.openSession(selectedSessionId)
  }, [selectedSession, selectedSessionId, sessionRuns])

  useEffect(() => () => sessionRuns.releaseForeground(), [sessionRuns])

  function selectSession(sessionId: string) {
    setDraftPrompt('')
    setDraftError(undefined)
    setSearchParams({ session: sessionId })
    setNavigationOpen(false)
  }

  function startDraft(project: ProjectSessionGroup) {
    if (!project.cwd) return
    setDraftPrompt('')
    setDraftError(undefined)
    setProjectCollapsed(project.key, false)
    setSearchParams({ draftProject: project.key })
    setNavigationOpen(false)
  }

  function removeProject(project: ProjectSessionGroup) {
    if (!project.cwd) return
    const next = projects.flatMap((candidate) => candidate.cwd === project.cwd ? [] : candidate.sessions)[0]
    hideProject(project.cwd)
    if (draftProject?.cwd === project.cwd || selectedSession?.cwd === project.cwd) setSearchParams(next ? { session: next.id } : {})
  }

  async function submitDraft() {
    if (!draftProject?.cwd || draftPrompt.trim().length === 0 || creatingDraft) return
    setCreatingDraft(true)
    setDraftError(undefined)
    try {
      const firstPrompt = draftPrompt.trim()
      const created = await createSession(draftProject.cwd, firstPrompt)
      sessionRuns.adopt({ historyTurnCount: 0, prompt: firstPrompt, sessionId: created.id })
      queryClient.setQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'], (current) => [created, ...(current ?? []).filter((session) => session.id !== created.id)])
      setDraftPrompt('')
      setSearchParams({ session: created.id })
      setNavigationOpen(false)
    } catch (cause) {
      setDraftError(cause instanceof Error ? cause.message : '创建 Pi 会话失败，请重试。')
    } finally {
      setCreatingDraft(false)
    }
  }

  function submitPrompt() {
    if (isDraft) return void submitDraft()
    if (!selectedSessionId || prompt.trim().length === 0) return
    if (!isActive) {
      if (sessionRuns.start({ historyTurnCount, prompt, sessionId: selectedSessionId })) setDraft(selectedSessionId, '')
    }
    else if (status === 'running') void (queueMode === 'steer' ? sessionRuns.steer(selectedSessionId, prompt) : sessionRuns.followUp(selectedSessionId, prompt)).then(() => setDraft(selectedSessionId, '')).catch((cause) => setControlError(cause instanceof Error ? cause.message : 'Pi 控制命令失败'))
  }

  const jumpToUnloadedTurn = useCallback((turnId: string, cursor: string | undefined) => {
    if (!selectedSessionId) return
    const sessionId = selectedSessionId
    void fetchSessionHistory(sessionId, cursor, history?.revision).then((page) => {
      if (sessionId !== selectedSessionIdRef.current) return
      queryClient.setQueryData<InfiniteData<PiSessionHistoryResponse, HistoryPageParam>>(sessionHistoryQueryKey(sessionId), (current) => ({
        pageParams: [...(current?.pageParams ?? []), { before: cursor, revision: history?.revision }],
        pages: mergeSessionHistoryPage(current?.pages, page),
      }))
      setPendingJump({ sessionId, turnId })
    })
  }, [history?.revision, queryClient, selectedSessionId])

  function abortPrompt() {
    if (!selectedSessionId || !isActive || status === 'aborting') return
    void sessionRuns.stop(selectedSessionId)
  }

  async function openControls() {
    if (!selectedSessionId) return
    setControlError(undefined)
    try {
      await sessionRuns.resumeRuntime(selectedSessionId)
      const [, availableModels, levels] = await Promise.all([
        sessionRuns.getRuntimeState(selectedSessionId), sessionRuns.getAvailableModels(selectedSessionId), sessionRuns.getAvailableThinkingLevels(selectedSessionId),
      ])
      setModels(availableModels)
      setThinkingLevels(levels)
    } catch (cause) {
      setControlError(cause instanceof Error ? cause.message : '无法读取 Pi 运行状态')
    }
  }

  async function handleRename(sessionId: string, name: string) {
    setMutatingSessionId(sessionId)
    try {
      await renameSession(sessionId, name)
      await sessionsQuery.refetch()
    } finally {
      setMutatingSessionId(undefined)
    }
  }

  async function handleDelete(sessionId: string) {
    setMutatingSessionId(sessionId)
    try {
      await deleteSession(sessionId)
      queryClient.removeQueries({ queryKey: sessionHistoryQueryKey(sessionId) })
      await sessionsQuery.refetch()
    } finally {
      setMutatingSessionId(undefined)
    }
  }

  async function changeModel(provider: string, modelId: string) {
    if (!selectedSessionId) return false
    try { await sessionRuns.setModel(selectedSessionId, provider, modelId); return true }
    catch (cause) { setControlError(cause instanceof Error ? cause.message : '模型切换失败'); return false }
  }

  async function changeThinkingLevel(level: string) {
    if (!selectedSessionId) return false
    try { await sessionRuns.setThinkingLevel(selectedSessionId, level); return true }
    catch (cause) { setControlError(cause instanceof Error ? cause.message : 'Thinking 切换失败'); return false }
  }

  async function compact() {
    if (!selectedSessionId) return false
    try { await sessionRuns.compact(selectedSessionId); return true }
    catch (cause) { setControlError(cause instanceof Error ? cause.message : '压缩失败'); return false }
  }

  return {
    selectedSessionId, selectedSession, draftProject, isDraft, prompt, currentRun, activeTurn, modelLabel, status, isActive, isStreaming,
    extensionStatus, extensionWidget, runtimeStatus, runtimeStates, runs, projects, removedProjects, collapsedProjectKeys,
    navigationOrder, setNavigationOrder, setProjectCollapsed, restoreProject, setDraft, setDraftPrompt,
    mutatingSessionId, creatingDraft, draftError, controlError, models, thinkingLevels, queueMode, setQueueMode,
    sessionsQuery, historyQuery, history, turnIndexQuery, pendingJump, setPendingJump,
    selectSession, startDraft, removeProject, submitPrompt, abortPrompt, openControls, handleRename, handleDelete,
    jumpToUnloadedTurn, revealProjectInFinder, changeModel, changeThinkingLevel, compact,
    loadEarlier: () => { void historyQuery.fetchPreviousPage() }, retryHistory: () => { void historyQuery.refetch() },
  }
}
