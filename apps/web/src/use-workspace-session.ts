import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { historyCacheVersion, historyUserTurnCount, mergeSessionHistoryPage, mergeSessionHistoryPages, sessionHistoryQueryKey, sessionTurnIndexQueryKey, type PiSessionHistoryResponse } from './history.js'
import { timelineItems } from './timeline-model.js'
import { applyNavigationOrder, navigationOrdersEqual, reconcileNavigationOrder } from './navigation-order.js'
import type { PiRuntimeModel, PiRuntimeState } from '@pi-nest/contracts'
import type { SessionRunController } from './session-run-controller.js'
import { thinkingCommand } from './thinking-command.js'
import { stripAnsiLine } from './ansi-text.js'
import { isRunActive } from './session-run-model.js'
import { useWorkspaceStore } from './workspace-store.js'
import { createSession, deleteSession, fetchSessionHistory, fetchSessions, renameSession, revealProjectInFinder, RequestError } from './workspace-api.js'
import { fetchSessionNavigation } from './session-navigation-query.js'
import { extensionStatusLine, extensionWidgetText, groupSessionsByProject, planModePolicy, runtimeStatusLabel, type ProjectSessionGroup } from './workspace.js'

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
  const runtimeDetails = useWorkspaceStore((state) => state.runtimeDetails)
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
  const [controlFailure, setControlFailure] = useState<{ sessionId: string; message: string }>()
  const controlError = controlFailure?.sessionId === selectedSessionId ? controlFailure.message : undefined
  function setControlError(message: string | undefined, sessionId = selectedSessionId) {
    if (sessionId !== selectedSessionIdRef.current) return
    setControlFailure(message === undefined ? undefined : { sessionId, message })
  }
  const [draftError, setDraftError] = useState<string>()
  const [draftPrompt, setDraftPrompt] = useState('')
  const [creatingDraft, setCreatingDraft] = useState(false)
  const runningInputRequests = useRef(new Set<string>())
  const [runningInputSessions, setRunningInputSessions] = useState<string[]>([])
  const submittingInput = runningInputSessions.includes(selectedSessionId)
  const [models, setModels] = useState<PiRuntimeModel[]>([])
  const [modelStatus, setModelStatus] = useState<'unloaded' | 'loading' | 'ready' | 'error' | 'switching'>('unloaded')
  const [modelError, setModelError] = useState<string>()
  const modelCache = useRef(new Map<string, { details: PiRuntimeState; models: PiRuntimeModel[] }>())
  const modelOperation = useRef<{ sessionId: string } | undefined>(undefined)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [thinkingStatus, setThinkingStatus] = useState<'unloaded' | 'loading' | 'ready' | 'error' | 'switching'>('unloaded')
  const [thinkingError, setThinkingError] = useState<string>()
  const [thinkingFailure, setThinkingFailure] = useState(0)
  const thinkingCache = useRef(new Map<string, { model: string; levels: string[] }>())
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([])
  const [controlSessionId, setControlSessionId] = useState(selectedSessionId)
  if (controlSessionId !== selectedSessionId) {
    setControlSessionId(selectedSessionId)
    setControlFailure(undefined)
    setModels([])
    setModelStatus('unloaded')
    setModelError(undefined)
    setThinkingLevels([])
    setThinkingStatus('unloaded')
    setThinkingError(undefined)
    setThinkingFailure(0)
    setThinkingOpen(false)
  }
  const [pendingJump, setPendingJump] = useState<{ sessionId: string; turnId: string }>()
  const selectedSessionIdRef = useRef(selectedSessionId)
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const sessions = sessionsQuery.data ?? emptySessions
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
  const currentRun = selectedSessionId ? runs[selectedSessionId] : undefined
  const activeTurn = currentRun?.turns.at(-1)
  const currentModel = runtimeDetails[selectedSessionId]?.model
  const modelKey = `${currentModel?.provider}/${currentModel?.id}`
  const [thinkingModelKey, setThinkingModelKey] = useState(modelKey)
  if (thinkingModelKey !== modelKey) {
    setThinkingModelKey(modelKey)
    setThinkingLevels([])
    setThinkingStatus('unloaded')
    setThinkingError(undefined)
  }
  const modelName = models.find((model) => model.id === currentModel?.id && model.provider === currentModel?.provider)?.name ?? currentModel?.id
  const modelLabel = currentModel?.id && currentModel.provider ? (modelName ?? currentModel.id) : '选择模型'
  const status = currentRun?.status ?? 'idle'
  const isActive = isRunActive(status)
  const isStreaming = status === 'running' || status === 'aborting'
  const extensionStatus = extensionStatusLine(extensionStatuses[selectedSessionId])
  const planStatus = stripAnsiLine(extensionStatuses[selectedSessionId]?.['plan-mode'] ?? '').trim()
  const planPolicy = planModePolicy(extensionWidgets[selectedSessionId])
  const extensionWidget = extensionWidgetText(extensionWidgets[selectedSessionId])
  const runtimeStatus = runtimeStatusLabel(runtimeStates[selectedSessionId], isActive)
  const hasCachedHistory = Boolean(queryClient.getQueryData(sessionHistoryQueryKey(selectedSessionId)))
  const historyEnabled = Boolean(selectedSession) && watchStates[selectedSessionId] === 'ready' && (!isActive || !hasCachedHistory) && runtimeStates[selectedSessionId]?.lifecycle !== 'loading' && (runtimeStates[selectedSessionId]?.lifecycle !== 'active' || !hasCachedHistory || status === 'awaiting_input')
  const historyQuery = useInfiniteQuery<PiSessionHistoryResponse, Error, InfiniteData<PiSessionHistoryResponse>, ReturnType<typeof sessionHistoryQueryKey>, HistoryPageParam>({
    enabled: historyEnabled,
    getNextPageParam: () => undefined,
    getPreviousPageParam: (firstPage) => firstPage.hasEarlier ? { before: firstPage.beforeCursor, revision: firstPage.revision } : undefined,
    initialPageParam: {},
    queryKey: sessionHistoryQueryKey(selectedSessionId),
    queryFn: ({ pageParam, signal }) => fetchSessionHistory(selectedSessionId, pageParam.before, pageParam.revision, signal),
    retry: false,
  })
  const completedRunId = useWorkspaceStore((state) => state.sessionNotifications[selectedSessionId]?.completedRunId)
  const history = useMemo(() => mergeSessionHistoryPages(historyQuery.data?.pages), [historyQuery.data?.pages])
  const planTurnId = timelineItems(history?.entries, currentRun?.turns ?? [], currentRun?.systemEvents ?? []).findLast((item) => item.plan)?.id
  const turnIndexQuery = useQuery({
    enabled: historyEnabled && !isActive && historyQuery.isSuccess && !historyQuery.isFetching && Boolean(history?.revision),
    queryKey: sessionTurnIndexQueryKey(selectedSessionId, history?.revision),
    queryFn: ({ signal }) => fetchSessionNavigation(selectedSessionId, history!.revision, signal, queryClient),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const navigationNotice = !isActive && turnIndexQuery.isError && !turnIndexQuery.isFetching
    ? turnIndexQuery.error instanceof RequestError && turnIndexQuery.error.code === 'SESSION_RUNNING'
      ? '执行结束后将更新轮次导航' : '完整轮次导航暂不可用'
    : undefined
  const historyJumpSequence = useRef(0)
  const historyRevisionRef = useRef(history?.revision)
  useEffect(() => { historyRevisionRef.current = history?.revision }, [history?.revision])
  const historyTurnCount = historyUserTurnCount(history?.entries)

  useEffect(() => {
    if (!selectedSessionId || watchStates[selectedSessionId] !== 'ready' || !completedRunId || !historyQuery.isSuccess || historyQuery.isFetching || historyQuery.isError) return
    const markRead = () => {
      if (document.visibilityState === 'visible') useWorkspaceStore.getState().markSessionRead(selectedSessionId, completedRunId)
    }
    markRead()
    document.addEventListener('visibilitychange', markRead)
    return () => document.removeEventListener('visibilitychange', markRead)
  }, [selectedSessionId, watchStates, completedRunId, historyQuery.isSuccess, historyQuery.isFetching, historyQuery.isError])

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId
    return () => { void queryClient.cancelQueries({ queryKey: ['session-history-page', selectedSessionId] }) }
  }, [selectedSessionId, queryClient])

  const sourceProjects = useMemo(() => groupSessionsByProject(sessions, navigationOrder.projectCreatedAt), [sessions, navigationOrder.projectCreatedAt])
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
    // An unloaded list must not erase the persisted drag order on startup.
    if (!sessionsQuery.isSuccess) return
    const reconciled = reconcileNavigationOrder(navigationOrder, sourceProjects)
    if (!navigationOrdersEqual(navigationOrder, reconciled)) setNavigationOrder(reconciled)
  }, [navigationOrder, setNavigationOrder, sourceProjects, sessionsQuery.isSuccess])

  useEffect(() => {
    if (!selectedSession) return
    sessionRuns.openSession(selectedSessionId)
  }, [selectedSession, selectedSessionId, sessionRuns])

  useEffect(() => {
    if (!selectedSession || watchStates[selectedSessionId] !== 'ready' || modelOperation.current?.sessionId === selectedSessionId) return
    if (runtimeDetails[selectedSessionId]?.model) return
    if (isActive || runtimeStates[selectedSessionId]?.lifecycle === 'active' || (modelStatus !== 'unloaded' && !(modelStatus === 'ready' && runtimeStates[selectedSessionId]?.lifecycle === 'notLoaded'))) return
    const operation = { sessionId: selectedSessionId }
    modelOperation.current = operation
    // oxlint-disable-next-line react/set-state-in-effect -- Initialize the external Pi runtime when this session becomes ready.
    setModelStatus('loading')
    setModelError(undefined)
    void (async () => {
      try {
        await sessionRuns.resumeRuntime(selectedSessionId)
        const store = useWorkspaceStore.getState()
        if (!store.runtimeDetails[selectedSessionId] && store.runtimeStates[selectedSessionId]?.lifecycle !== 'active') await sessionRuns.getRuntimeState(selectedSessionId)
        if (selectedSessionIdRef.current === selectedSessionId && modelOperation.current === operation) setModelStatus('ready')
      } catch (cause) {
        if (selectedSessionIdRef.current !== selectedSessionId || modelOperation.current !== operation) return
        if (useWorkspaceStore.getState().runtimeStates[selectedSessionId]?.lifecycle === 'active') setModelStatus('ready')
        else {
          setModelError(cause instanceof Error ? cause.message : '无法读取模型，请重试。')
          setModelStatus('error')
        }
      } finally {
        if (modelOperation.current === operation) modelOperation.current = undefined
      }
    })()
  }, [selectedSession, selectedSessionId, watchStates, runtimeDetails, runtimeStates, isActive, modelStatus, sessionRuns])

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

  function submitPrompt(mode: 'follow_up' | 'steer' = 'follow_up') {
    const command = thinkingCommand(prompt)
    if (command) {
      if (isDraft || !selectedSessionId) { setDraftError('请先进入已有会话，再调整思考等级。'); return }
      if (isActive) { setControlError('生成结束后可调整思考等级。'); return }
      if (modelOperation.current?.sessionId === selectedSessionId) { setControlError('正在处理会话设置，请稍后重试。'); return }
      setThinkingOpen(true)
      if (command.level) void changeThinkingLevel(command.level).then((changed) => { if (changed) setDraft(selectedSessionId, '') })
      else { setDraft(selectedSessionId, ''); void openThinking() }
      return
    }
    if (modelOperation.current?.sessionId === selectedSessionId) return
    setControlError(undefined)
    if (isDraft) return void submitDraft()
    if (!selectedSessionId || prompt.trim().length === 0) return
    if (!isActive) {
      if (sessionRuns.start({ historyAnchorId: history?.entries.filter((entry) => (entry.raw.message as { role?: string } | undefined)?.role === 'user').at(-1)?.id, historyTurnCount, prompt, sessionId: selectedSessionId })) setDraft(selectedSessionId, '')
    }
    else if (status === 'running') {
      if (runningInputRequests.current.has(selectedSessionId)) return
      const sessionId = selectedSessionId
      const message = prompt
      runningInputRequests.current.add(sessionId)
      setRunningInputSessions([...runningInputRequests.current])
      void (async () => {
        try {
          if (mode === 'steer') await sessionRuns.steer(sessionId, message)
          else await sessionRuns.followUp(sessionId, message)
          if (useWorkspaceStore.getState().drafts[sessionId] === message) setDraft(sessionId, '')
        } catch (cause) {
          const ended = cause instanceof Error && 'code' in cause && cause.code === 'SESSION_NOT_RUNNING' && !isRunActive(useWorkspaceStore.getState().runs[sessionId]?.status ?? 'idle')
          if (ended && sessionRuns.start({ prompt: message, sessionId })) {
            if (useWorkspaceStore.getState().drafts[sessionId] === message) setDraft(sessionId, '')
          } else setControlError(cause instanceof Error ? cause.message : 'Pi 控制命令失败', sessionId)
        } finally {
          runningInputRequests.current.delete(sessionId)
          setRunningInputSessions([...runningInputRequests.current])
        }
      })()
    }
  }

  const readHistoryPage = useCallback((cursor: string | undefined) => queryClient.fetchQuery({
    queryKey: ['session-history-page', selectedSessionId, historyCacheVersion, history?.revision, cursor],
    queryFn: ({ signal }) => fetchSessionHistory(selectedSessionId, cursor, history?.revision, signal),
    staleTime: Infinity,
  }), [history?.revision, queryClient, selectedSessionId])

  const readTurnPrompt = useCallback(async (turnId: string, cursor: string | undefined) => {
    const sessionId = selectedSessionId
    const revision = history?.revision
    const page = await readHistoryPage(cursor)
    if (sessionId !== selectedSessionIdRef.current || revision !== historyRevisionRef.current || (revision && page.revision !== revision)) throw new Error('会话历史已变化，请重试。')
    const prompt = timelineItems(page.entries, [], []).find((turn) => turn.id === turnId)?.prompt
    if (prompt === undefined) throw new Error('未找到用户消息，请重试。')
    return prompt
  }, [history?.revision, readHistoryPage, selectedSessionId])

  const jumpToUnloadedTurn = useCallback(async (turnId: string, cursor: string | undefined) => {
    if (!selectedSessionId) return
    const sessionId = selectedSessionId
    const operation = ++historyJumpSequence.current
    const page = await readHistoryPage(cursor)
    if (operation !== historyJumpSequence.current) return
    if (sessionId !== selectedSessionIdRef.current || history?.revision !== historyRevisionRef.current) throw new Error('会话历史已变化，请重试。')
    queryClient.setQueryData<InfiniteData<PiSessionHistoryResponse, HistoryPageParam>>(sessionHistoryQueryKey(sessionId), (current) => ({
      pageParams: [...(current?.pageParams ?? []), { before: cursor, revision: history?.revision }],
      pages: mergeSessionHistoryPage(current?.pages, page),
    }))
    setPendingJump({ sessionId, turnId })
  }, [history?.revision, queryClient, readHistoryPage, selectedSessionId])

  function abortPrompt() {
    if (!selectedSessionId || !isActive || status === 'aborting') return
    void sessionRuns.stop(selectedSessionId)
  }

  async function openModels(refresh = false) {
    if (!selectedSessionId || modelOperation.current?.sessionId === selectedSessionId) return
    const cached = modelCache.current.get(selectedSessionId)
    if (!refresh && cached && cached.details === useWorkspaceStore.getState().runtimeDetails[selectedSessionId]) {
      setModels(cached.models)
      setModelStatus('ready')
      setModelError(undefined)
      return
    }
    if (isActive) return
    const operation = { sessionId: selectedSessionId }
    modelOperation.current = operation
    setModelStatus('loading')
    setModelError(undefined)
    try {
      await sessionRuns.resumeRuntime(selectedSessionId)
      await sessionRuns.getRuntimeState(selectedSessionId)
      const availableModels = await sessionRuns.getAvailableModels(selectedSessionId)
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return
      const details = useWorkspaceStore.getState().runtimeDetails[selectedSessionId]
      if (details) modelCache.current.set(selectedSessionId, { details, models: availableModels })
      setModels(availableModels)
      setModelStatus('ready')
    } catch (cause) {
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return
      setModelError(cause instanceof Error ? cause.message : '无法读取模型，请重试。')
      setModelStatus('error')
    } finally {
      if (modelOperation.current === operation) modelOperation.current = undefined
    }
  }

  async function openThinking(refresh = false) {
    if (!selectedSessionId || modelOperation.current?.sessionId === selectedSessionId) return
    const model = `${currentModel?.provider}/${currentModel?.id}`
    const cached = thinkingCache.current.get(selectedSessionId)
    if (!refresh && cached?.model === model) { setThinkingLevels(cached.levels); setThinkingStatus('ready'); return }
    if (isActive) return
    const operation = { sessionId: selectedSessionId }
    modelOperation.current = operation
    setThinkingStatus('loading')
    setThinkingError(undefined)
    try {
      await sessionRuns.resumeRuntime(selectedSessionId)
      await sessionRuns.getRuntimeState(selectedSessionId)
      const levels = await sessionRuns.getAvailableThinkingLevels(selectedSessionId)
      const actualModel = useWorkspaceStore.getState().runtimeDetails[selectedSessionId]?.model
      thinkingCache.current.set(selectedSessionId, { model: `${actualModel?.provider}/${actualModel?.id}`, levels })
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return
      setThinkingLevels(levels)
      setThinkingStatus('ready')
    } catch (cause) {
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return
      setThinkingError(cause instanceof Error ? cause.message : '无法读取思考等级，请重试。')
      setThinkingStatus('error')
    } finally { if (modelOperation.current === operation) modelOperation.current = undefined }
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
      useWorkspaceStore.getState().removeSessionNotification(sessionId)
      queryClient.removeQueries({ queryKey: sessionHistoryQueryKey(sessionId) })
      queryClient.removeQueries({ queryKey: ['session-history-page', sessionId] })
      await sessionsQuery.refetch()
    } finally {
      setMutatingSessionId(undefined)
    }
  }

  async function changeModel(provider: string, modelId: string) {
    if (!selectedSessionId || isActive || modelOperation.current?.sessionId === selectedSessionId) return false
    const operation = { sessionId: selectedSessionId }
    modelOperation.current = operation
    setModelStatus('switching')
    setModelError(undefined)
    try {
      await sessionRuns.setModel(selectedSessionId, provider, modelId)
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return false
      const details = useWorkspaceStore.getState().runtimeDetails[selectedSessionId]
      const cached = modelCache.current.get(selectedSessionId)
      if (details && cached) modelCache.current.set(selectedSessionId, { ...cached, details })
      thinkingCache.current.delete(selectedSessionId)
      setThinkingLevels([])
      setThinkingStatus('unloaded')
      setThinkingError(undefined)
        setModelStatus('ready')
      return true
    } catch (cause) {
      if (selectedSessionId === selectedSessionIdRef.current && modelOperation.current === operation) {
        setModelError(cause instanceof Error ? cause.message : '模型切换失败，请重试。')
        setModelStatus('ready')
      }
      return false
    } finally {
      if (modelOperation.current === operation) modelOperation.current = undefined
    }
  }

  async function changeThinkingLevel(level: string) {
    if (!selectedSessionId || isActive || modelOperation.current?.sessionId === selectedSessionId) return false
    const operation = { sessionId: selectedSessionId }
    modelOperation.current = operation
    setThinkingStatus('switching')
    setThinkingError(undefined)
    try {
      await sessionRuns.resumeRuntime(selectedSessionId)
      const levels = await sessionRuns.getAvailableThinkingLevels(selectedSessionId)
      const model = useWorkspaceStore.getState().runtimeDetails[selectedSessionId]?.model
      thinkingCache.current.set(selectedSessionId, { model: `${model?.provider}/${model?.id}`, levels })
      if (selectedSessionId === selectedSessionIdRef.current && modelOperation.current === operation) setThinkingLevels(levels)
      if (!levels.includes(level)) throw new Error(`未知思考等级“${level}”。可用等级：${levels.join('、') || '无'}`)
      await sessionRuns.setThinkingLevel(selectedSessionId, level)
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return false
      const effective = useWorkspaceStore.getState().runtimeDetails[selectedSessionId]?.thinkingLevel
      if (effective === undefined) throw new Error('Pi 未返回实际思考等级，请重试确认。')
      setThinkingStatus('ready')
      setThinkingOpen(false)
      return true
    } catch (cause) {
      if (selectedSessionId === selectedSessionIdRef.current && modelOperation.current === operation) {
        console.error('Pi thinking change failed', cause)
        setThinkingFailure((failure) => failure + 1)
        setThinkingStatus('ready')
      }
      return false
    } finally { if (modelOperation.current === operation) modelOperation.current = undefined }
  }

  return {
    selectedSessionId, selectedSession, draftProject, isDraft, prompt, currentRun, activeTurn, currentModel, modelLabel, modelStatus, modelError, status, isActive, isStreaming,
    extensionStatus, extensionWidget, planStatus, planPolicy, runtimeStatus, runtimeStates, runs, projects, removedProjects, collapsedProjectKeys,
    navigationOrder, setNavigationOrder, setProjectCollapsed, restoreProject, setDraft, setDraftPrompt,
    mutatingSessionId, creatingDraft, draftError, controlError, models, thinkingLevels, thinkingOpen, setThinkingOpen, thinkingStatus, thinkingError, thinkingFailure, currentThinkingLevel: runtimeDetails[selectedSessionId]?.thinkingLevel,
    sessionsQuery, historyQuery, history, planTurnId, turnIndexQuery, navigationNotice, retryNavigation: () => { void turnIndexQuery.refetch() }, pendingJump, setPendingJump,
    selectSession, startDraft, removeProject, submitPrompt, submittingInput, abortPrompt, openModels, openThinking, handleRename, handleDelete,
    readTurnPrompt, jumpToUnloadedTurn, revealProjectInFinder, changeModel, changeThinkingLevel,
    loadEarlier: () => { void historyQuery.fetchPreviousPage() }, retryHistory: () => { void historyQuery.refetch() },
  }
}
