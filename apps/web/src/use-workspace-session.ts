import { useAttachmentDraft, setDraftAttachments } from './attachment-draft.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { sessionHistoryQueryKey } from './history.js'
import { useSessionHistory } from './use-session-history.js'
import { timelineItems } from './timeline-model.js'
import { applyNavigationOrder, navigationOrdersEqual, reconcileNavigationOrder } from './navigation-order.js'
import type { PiProject, PiSessionInitialSettings, PiSessionBranchRequest, PiRuntimeModel, PiRuntimeState } from '@pi-nest/contracts'
import type { SessionRunController } from './session-run-controller.js'
import { stripAnsiLine } from './ansi-text.js'
import { activeRuntimeTurn, isRunActive } from './session-run-model.js'
import { useWorkspaceStore } from './workspace-store.js'
import { branchSession, createSession, deleteSession, fetchProjects, fetchSessions, fetchPiConfiguration, renameSession, revealProjectInFinder } from './workspace-api.js'
import { extensionStatusLine, extensionWidgetText, groupSessionsByProject, projectName, projectSessionGroupKey, planModePolicy, runtimeStatusLabel, type ProjectSessionGroup } from './workspace.js'

const emptyProjects: PiProject[] = []
const emptySessions: Awaited<ReturnType<typeof fetchSessions>> = []

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
  const [draftSettings, setDraftSettings] = useState<Record<string, PiSessionInitialSettings>>({})
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
  const controlKey = selectedSessionId || draftProjectKey
  const [controlSessionId, setControlSessionId] = useState(controlKey)
  if (controlSessionId !== controlKey) {
    setControlSessionId(controlKey)
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
  const selectedSessionIdRef = useRef(selectedSessionId)
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: fetchProjects, retry: false })
  const sessions = sessionsQuery.data ?? emptySessions
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
  const sessionResolution = !selectedSessionId ? 'none' : selectedSession ? 'ready' : sessionsQuery.isPending ? 'restoring' : sessionsQuery.isError ? 'error' : 'missing'
  const currentRun = selectedSessionId ? runs[selectedSessionId] : undefined
  const activeTurn = currentRun && activeRuntimeTurn(currentRun.turns)
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
  const { history, historyQuery, historyError, historyTurnCount, turnIndexQuery, navigationNotice, retryNavigation, pendingJump, setPendingJump, readTurnPrompt, jumpToUnloadedTurn, loadEarlier, retryHistory } = useSessionHistory(selectedSessionId, Boolean(selectedSessionId))
  const completedRunId = useWorkspaceStore((state) => state.sessionNotifications[selectedSessionId]?.completedRunId)
  const planTurnId = timelineItems(history?.entries, currentRun?.turns ?? [], currentRun?.systemEvents ?? []).findLast((item) => item.plan)?.id

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
  }, [selectedSessionId, queryClient])

  const sourceProjects = useMemo(() => groupSessionsByProject(sessions, navigationOrder.projectCreatedAt, projectsQuery.data ?? emptyProjects), [sessions, navigationOrder.projectCreatedAt, projectsQuery.data])
  const orderedProjects = useMemo(() => applyNavigationOrder(sourceProjects, navigationOrder), [navigationOrder, sourceProjects])
  const projects = useMemo(() => orderedProjects.filter((project) => !project.cwd || !hiddenProjectCwds[project.cwd]), [hiddenProjectCwds, orderedProjects])
  const draftProject = !selectedSessionId ? projects.find((project) => project.key === draftProjectKey) : undefined
  const attachmentDraft = useAttachmentDraft(selectedSessionId, draftProject?.cwd)
  const isDraft = Boolean(draftProject)
  const prompt = isDraft ? draftPrompt : drafts[selectedSessionId] ?? ''
  const draftCwd = draftProject?.cwd ?? ''
  const draftConfiguration = useQuery({ queryKey: ['draft-configuration', draftCwd], queryFn: () => fetchPiConfiguration(undefined, draftCwd), enabled: isDraft, retry: false })
  const draftModels = draftConfiguration.data?.models ?? []
  const draftDefaults = draftConfiguration.data?.settings.effective
  const draftSelection = draftSettings[draftCwd]
  const draftModel = draftSelection?.model ?? draftModels.find((model) => model.provider === draftDefaults?.defaultProvider && model.id === draftDefaults?.defaultModel)
  const draftLevels = draftModels.find((model) => model.provider === draftModel?.provider && model.id === draftModel?.id)?.thinkingLevels ?? []
  const requestedThinking = draftSelection?.thinkingLevel ?? draftDefaults?.defaultThinkingLevel
  const draftThinking = requestedThinking && draftLevels.includes(requestedThinking) ? requestedThinking : draftLevels[0]
  const draftSettingsStatus = creatingDraft ? 'switching' : draftConfiguration.isFetching ? 'loading' : draftConfiguration.isError ? 'error' : 'ready'
  const draftSettingsError = draftConfiguration.error?.message
  const loadDraftSettings = async (refresh: boolean) => {
    const result = refresh || !draftConfiguration.data ? await draftConfiguration.refetch() : draftConfiguration
    return result.data?.models
  }

  useEffect(() => {
    // An unloaded list must not erase the persisted drag order on startup.
    if (!sessionsQuery.isSuccess || !projectsQuery.isSuccess) return
    const reconciled = reconcileNavigationOrder(navigationOrder, sourceProjects)
    if (!navigationOrdersEqual(navigationOrder, reconciled)) setNavigationOrder(reconciled)
  }, [navigationOrder, setNavigationOrder, sourceProjects, sessionsQuery.isSuccess, projectsQuery.isSuccess])

  useEffect(() => {
    if (!selectedSessionId) return
    sessionRuns.openSession(selectedSessionId)
  }, [selectedSessionId, sessionRuns])

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

  function openProject(project: PiProject) {
    queryClient.setQueryData<PiProject[]>(['projects'], (saved = []) => [...saved.filter((item) => item.cwd !== project.cwd), project])
    restoreProject(project.cwd)
    startDraft({ ...project, key: projectSessionGroupKey(project.cwd), name: projectName(project.cwd), sessions: [] })
  }

  function removeProject(project: ProjectSessionGroup) {
    if (!project.cwd) return
    hideProject(project.cwd)
    if (draftProject?.cwd === project.cwd || selectedSession?.cwd === project.cwd) setSearchParams({})
  }

  async function submitDraft() {
    if (!draftProject?.cwd || (!draftPrompt.trim() && !attachmentDraft.items.length) || creatingDraft) return
    setCreatingDraft(true)
    setDraftError(undefined)
    try {
      const firstPrompt = draftPrompt.trim()
      const attachedItems = [...attachmentDraft.items]
      const input = attachmentDraft.submission(firstPrompt)
      const attachments = input && attachmentDraft.scope?.kind === 'draft' ? { attachmentIds: input.attachmentIds, submissionId: input.submissionId, draftId: attachmentDraft.scope.draftId } : undefined
      const selection = draftSettings[draftProject.cwd]
      if (selection && (draftConfiguration.isError || draftConfiguration.isFetching)) throw new Error('请先重新加载模型配置，再发送消息。')
      if (selection?.model && !draftModels.some((model) => model.provider === selection.model?.provider && model.id === selection.model.id)) throw new Error('所选模型已不可用，请重新选择。')
      const initialSettings = selection ? { ...selection, ...(selection.thinkingLevel !== undefined ? { thinkingLevel: draftThinking } : {}) } : undefined
      const created = await createSession(draftProject.cwd, firstPrompt, attachments, initialSettings)
      attachmentDraft.clear(attachedItems)
      sessionRuns.adopt({ historyTurnCount: 0, prompt: firstPrompt || '请查看附件。', ...(input ? { attachments: input.attachments, submissionId: input.submissionId } : {}), sessionId: created.id })
      queryClient.setQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'], (current) => [created, ...(current ?? []).filter((session) => session.id !== created.id)])
      setDraftPrompt((value) => value.trim() === firstPrompt ? '' : value)
      setSearchParams({ session: created.id })
      setNavigationOpen(false)
    } catch (cause) {
      setDraftError(cause instanceof Error ? cause.message : '创建 Pi 会话失败，请重试。')
      if (cause instanceof Error && 'sessionId' in cause && typeof cause.sessionId === 'string') {
        setDraftAttachments(cause.sessionId, attachmentDraft.snapshot())
        useWorkspaceStore.getState().setDraft(cause.sessionId, draftPrompt)
        setControlFailure({ sessionId: cause.sessionId, message: cause.message })
        setSearchParams({ session: cause.sessionId })
        void sessionsQuery.refetch()
      }
    } finally {
      setCreatingDraft(false)
    }
  }

  function submitPrompt(mode: 'follow_up' | 'steer' = 'follow_up') {
    if (attachmentDraft.items.length && (attachmentDraft.busy || prompt.trimStart().startsWith('/'))) {
      const error = attachmentDraft.busy ? '请等待附件上传完成，或移除失败的附件。' : '带附件时暂不支持命令，请先移除附件。'
      if (isDraft) setDraftError(error); else setControlError(error)
      return
    }
    if (modelOperation.current?.sessionId === selectedSessionId) return
    setControlError(undefined)
    if (isDraft) return void submitDraft()
    if (!selectedSessionId || (!prompt.trim() && !attachmentDraft.items.length)) return
    const input = attachmentDraft.submission(prompt)
    const attachedItems = [...attachmentDraft.items]
    const acceptedAttachments = () => attachmentDraft.clear(attachedItems)
    if (!isActive) {
      if (sessionRuns.start({ ...(input ? { attachments: input.attachments, submissionId: input.submissionId, onAccepted: () => { acceptedAttachments(); if (useWorkspaceStore.getState().drafts[selectedSessionId] === prompt) setDraft(selectedSessionId, '') } } : {}), historyAnchorId: history?.entries.filter((entry) => (entry.raw.message as { role?: string } | undefined)?.role === 'user').at(-1)?.id, historyTurnCount, prompt: prompt || '请查看附件。', sessionId: selectedSessionId }) && !input) setDraft(selectedSessionId, '')
    }
    else if (status === 'running') {
      if (runningInputRequests.current.has(selectedSessionId)) return
      const sessionId = selectedSessionId
      const message = prompt
      runningInputRequests.current.add(sessionId)
      setRunningInputSessions([...runningInputRequests.current])
      if (!input && mode === 'steer' && useWorkspaceStore.getState().drafts[sessionId] === message) setDraft(sessionId, '')
      void (async () => {
        try {
          if (mode === 'steer') await sessionRuns.steer(sessionId, message || '请查看附件。', ...(input ? [input] : []))
          else await sessionRuns.followUp(sessionId, message || '请查看附件。', ...(input ? [input] : []))
          acceptedAttachments()
          if (useWorkspaceStore.getState().drafts[sessionId] === message) setDraft(sessionId, '')
        } catch (cause) {
          const ended = mode === 'follow_up' && cause instanceof Error && 'code' in cause && cause.code === 'SESSION_NOT_RUNNING' && !isRunActive(useWorkspaceStore.getState().runs[sessionId]?.status ?? 'idle')
          if (ended && sessionRuns.start({ prompt: message || '请查看附件。', sessionId, ...(input ? { attachments: input.attachments, submissionId: input.submissionId, onAccepted: () => { acceptedAttachments(); if (useWorkspaceStore.getState().drafts[sessionId] === message) setDraft(sessionId, '') } } : {}) })) {
            if (!input && useWorkspaceStore.getState().drafts[sessionId] === message) setDraft(sessionId, '')
          } else setControlError(cause instanceof Error ? cause.message : 'Pi 控制命令失败', sessionId)
        } finally {
          runningInputRequests.current.delete(sessionId)
          setRunningInputSessions([...runningInputRequests.current])
        }
      })()
    }
  }

  async function steerQueued(inputId: string) {
    const sessionId = selectedSessionId
    if (status !== 'running' || runningInputRequests.current.has(sessionId)) return
    runningInputRequests.current.add(sessionId)
    setRunningInputSessions([...runningInputRequests.current])
    setControlError(undefined)
    try { await sessionRuns.steerQueued(sessionId, inputId) }
    catch (cause) { setControlError(cause instanceof Error ? cause.message : '引导发送失败', sessionId) }
    finally {
      runningInputRequests.current.delete(sessionId)
      setRunningInputSessions([...runningInputRequests.current])
    }
  }

  async function retrySteering(turnId: string) {
    const sessionId = selectedSessionId
    if (status !== 'running' || runningInputRequests.current.has(sessionId)) return
    runningInputRequests.current.add(sessionId)
    setRunningInputSessions([...runningInputRequests.current])
    try { await sessionRuns.retrySteering(sessionId, turnId) }
    catch (cause) { setControlError(cause instanceof Error ? cause.message : '引导重试失败', sessionId) }
    finally {
      runningInputRequests.current.delete(sessionId)
      setRunningInputSessions([...runningInputRequests.current])
    }
  }

  function abortPrompt() {
    if (!selectedSessionId || !isActive || status === 'aborting') return
    void sessionRuns.stop(selectedSessionId)
  }

  async function openModels(refresh = false) {
    if (isDraft) return loadDraftSettings(refresh)
    if (!selectedSessionId || modelOperation.current?.sessionId === selectedSessionId) return
    const cached = modelCache.current.get(selectedSessionId)
    if (!refresh && cached && cached.details === useWorkspaceStore.getState().runtimeDetails[selectedSessionId]) {
      setModels(cached.models)
      setModelStatus('ready')
      setModelError(undefined)
      return cached.models
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
      return availableModels
    } catch (cause) {
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return
      setModelError(cause instanceof Error ? cause.message : '无法读取模型，请重试。')
      setModelStatus('error')
    } finally {
      if (modelOperation.current === operation) modelOperation.current = undefined
    }
  }

  async function openThinking(refresh = false) {
    if (isDraft) { await loadDraftSettings(refresh); return }
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

  async function createBranch(request: PiSessionBranchRequest) {
    const sessionId = selectedSessionId
    if (!selectedSession || isActive || modelOperation.current?.sessionId === sessionId || mutatingSessionId === sessionId) throw new Error('请等待当前会话操作结束后再创建分支。')
    setMutatingSessionId(sessionId)
    try {
      const result = await branchSession(sessionId, request)
      queryClient.setQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'], (current) => [result.session, ...(current ?? []).filter((session) => session.id !== result.session.id)])
      useWorkspaceStore.getState().setDraft(result.session.id, result.draft)
      if (result.attachments?.length) setDraftAttachments(result.session.id, result.attachments)
      return result
    } finally { setMutatingSessionId(undefined) }
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
      useWorkspaceStore.getState().clearFilePreview(sessionId)
      queryClient.removeQueries({ queryKey: ['session-file-preview', sessionId] })
      queryClient.setQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'], (current) => current?.filter((session) => session.id !== sessionId))
      if (selectedSessionIdRef.current === sessionId) {
        const next = projects.flatMap((project) => project.sessions).find((session) => session.id !== sessionId)
        if (!next) sessionRuns.releaseForeground()
        setSearchParams(next ? { session: next.id } : {})
      }
      queryClient.removeQueries({ queryKey: sessionHistoryQueryKey(sessionId) })
      queryClient.removeQueries({ queryKey: ['session-history-page', sessionId] })
      await sessionsQuery.refetch()
    } finally {
      setMutatingSessionId(undefined)
    }
  }

  async function changeModel(provider: string, modelId: string) {
    if (isDraft) {
      const model = draftModels.find((candidate) => candidate.provider === provider && candidate.id === modelId)
      if (!model || creatingDraft) return false
      const level = draftThinking && model.thinkingLevels.includes(draftThinking) ? draftThinking : model.thinkingLevels[0]
      setDraftSettings((current) => ({ ...current, [draftCwd]: { model: { provider, id: modelId }, ...(level !== undefined ? { thinkingLevel: level } : {}) } }))
      return true
    }
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
    if (isDraft) {
      if (!draftModel || !draftLevels.includes(level) || creatingDraft) return false
      setDraftSettings((current) => ({ ...current, [draftCwd]: { model: { provider: draftModel.provider, id: draftModel.id }, thinkingLevel: level } }))
      setThinkingOpen(false)
      return true
    }
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
    attachmentDraft, selectedSessionId, selectedSession, sessionResolution, draftProject, isDraft, prompt, currentRun, activeTurn, currentModel: isDraft ? draftModel : currentModel, modelLabel: isDraft ? (draftModels.find((model) => model.provider === draftModel?.provider && model.id === draftModel?.id)?.name ?? draftModel?.id ?? '选择模型') : modelLabel, modelStatus: isDraft ? draftSettingsStatus : modelStatus, modelError: isDraft ? draftSettingsError : modelError, status, isActive, isStreaming,
    extensionStatus, extensionWidget, planStatus, planPolicy, runtimeStatus, runtimeStates, runs, projects, collapsedProjectKeys,
    navigationOrder, setNavigationOrder, setProjectCollapsed, setDraft, setDraftPrompt,
    mutatingSessionId, creatingDraft, draftError, controlError, models: isDraft ? draftModels : models, thinkingLevels: isDraft ? draftLevels : thinkingLevels, thinkingOpen, setThinkingOpen, thinkingStatus: isDraft ? draftSettingsStatus : thinkingStatus, thinkingError: isDraft ? draftSettingsError : thinkingError, thinkingFailure, currentThinkingLevel: isDraft ? draftThinking : runtimeDetails[selectedSessionId]?.thinkingLevel,
    sessionsQuery, projectsQuery, historyQuery, history, historyError, planTurnId, turnIndexQuery, navigationNotice, retryNavigation, pendingJump, setPendingJump,
    selectSession, createBranch, startDraft, openProject, removeProject, submitPrompt, steerQueued, retrySteering, submittingInput, abortPrompt, openModels, openThinking, handleRename, handleDelete,
    readTurnPrompt, jumpToUnloadedTurn, revealProjectInFinder, changeModel, changeThinkingLevel,
    loadEarlier, retryHistory,
  }
}
