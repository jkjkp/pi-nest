import { useAttachmentDraft } from './attachment-draft.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { useSessionHistory } from './use-session-history.js'
import { useSessionModels } from './use-session-models.js'
import { useSessionActions } from './use-session-actions.js'
import { useWorkspaceDraft } from './use-workspace-draft.js'
import { timelineItems } from './timeline-model.js'
import { applyNavigationOrder, navigationOrdersEqual, reconcileNavigationOrder } from './navigation-order.js'
import type { PiProject } from '@pi-nest/contracts'
import type { SessionRunController } from './session-run-controller.js'
import { stripAnsiLine } from './ansi-text.js'
import { activeRuntimeTurn, isRunActive } from './session-run-model.js'
import { useWorkspaceStore } from './workspace-store.js'
import { fetchProjects, fetchSessions, openProjectFolder } from './workspace-api.js'
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
  const [controlFailure, setControlFailure] = useState<{ sessionId: string; message: string }>()
  const controlError = controlFailure?.sessionId === selectedSessionId ? controlFailure.message : undefined
  function setControlError(message: string | undefined, sessionId = selectedSessionId) {
    if (sessionId !== selectedSessionIdRef.current) return
    setControlFailure(message === undefined ? undefined : { sessionId, message })
  }
  const runningInputRequests = useRef(new Set<string>())
  const [runningInputSessions, setRunningInputSessions] = useState<string[]>([])
  const submittingInput = runningInputSessions.includes(selectedSessionId)
  const controlKey = selectedSessionId || draftProjectKey
  const [controlSessionId, setControlSessionId] = useState(controlKey)
  if (controlSessionId !== controlKey) {
    setControlSessionId(controlKey)
    setControlFailure(undefined)
  }
  const selectedSessionIdRef = useRef(selectedSessionId)
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: fetchProjects, retry: false })
  const sessions = sessionsQuery.data ?? emptySessions
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
  const sessionResolution = !selectedSessionId ? 'none' : selectedSession ? 'ready' : sessionsQuery.isPending ? 'restoring' : sessionsQuery.isError ? 'error' : 'missing'
  const currentRun = selectedSessionId ? runs[selectedSessionId] : undefined
  const activeTurn = currentRun && activeRuntimeTurn(currentRun.turns)
  const status = currentRun?.status ?? 'idle'
  const isActive = isRunActive(status)
  const isStreaming = status === 'running' || status === 'aborting'
  const extensionStatus = extensionStatusLine(extensionStatuses[selectedSessionId])
  const planStatus = stripAnsiLine(extensionStatuses[selectedSessionId]?.['plan-mode'] ?? '').trim()
  const planPolicy = planModePolicy(extensionWidgets[selectedSessionId])
  const extensionWidget = extensionWidgetText(extensionWidgets[selectedSessionId])
  const runtimeStatus = runtimeStatusLabel(runtimeStates[selectedSessionId], isActive)
  const { history, historyQuery, historyError, historyTurnCount, turnIndexQuery, navigationNotice, retryNavigation, pendingJump, jumpError, cancelTurnJump, finishTurnJump, readTurnPrompt, requestTurnJump, loadEarlier, retryHistory } = useSessionHistory(selectedSessionId, Boolean(selectedSessionId))
  const completedRunId = useWorkspaceStore((state) => state.sessionNotifications[selectedSessionId]?.completedRunId)
  const planTurnId = timelineItems(history?.entries, currentRun?.turns ?? [], currentRun?.systemEvents ?? []).findLast((item) => item.plan)?.id

  useEffect(() => {
    if (!selectedSessionId || watchStates[selectedSessionId] !== 'ready' || !completedRunId || !historyQuery.isSuccess || historyQuery.isFetching || historyQuery.isError) return
    const markRead = () => {
      if (document.visibilityState === 'visible') sessionRuns.markSessionRead(selectedSessionId, completedRunId)
    }
    markRead()
    document.addEventListener('visibilitychange', markRead)
    return () => document.removeEventListener('visibilitychange', markRead)
  }, [selectedSessionId, watchStates, completedRunId, historyQuery.isSuccess, historyQuery.isFetching, historyQuery.isError, sessionRuns])

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId
  }, [selectedSessionId, queryClient])

  const sourceProjects = useMemo(() => groupSessionsByProject(sessions, navigationOrder.projectCreatedAt, projectsQuery.data ?? emptyProjects), [sessions, navigationOrder.projectCreatedAt, projectsQuery.data])
  const orderedProjects = useMemo(() => applyNavigationOrder(sourceProjects, navigationOrder), [navigationOrder, sourceProjects])
  const projects = useMemo(() => orderedProjects.filter((project) => !project.cwd || !hiddenProjectCwds[project.cwd]), [hiddenProjectCwds, orderedProjects])
  const draftProject = !selectedSessionId ? projects.find((project) => project.key === draftProjectKey) : undefined
  const attachmentDraft = useAttachmentDraft(selectedSessionId, draftProject?.cwd)
  const isDraft = Boolean(draftProject)

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

  const sessionModels = useSessionModels({ sessionRuns, selectedSessionId, selectedSession, selectedSessionIdRef, controlKey, isActive })
  const {
    models, modelStatus, modelError, modelOperation, currentModel, modelLabel,
    thinkingOpen, setThinkingOpen, thinkingStatus, thinkingError, thinkingFailure, thinkingLevels,
  } = sessionModels

  const draft = useWorkspaceDraft({
    sessionRuns, draftProject, attachmentDraft, refetchSessions: sessionsQuery.refetch,
    setSearchParams, setControlFailure, setThinkingOpen,
  })
  const {
    draftPrompt, setDraftPrompt, draftError, setDraftError, creatingDraft, submitDraft,
    draftModels, draftModel, draftLevels, draftThinking, draftSettingsStatus, draftSettingsError, loadDraftSettings,
  } = draft
  const prompt = isDraft ? draftPrompt : drafts[selectedSessionId] ?? ''

  const { mutatingSessionId, createBranch, handleRename, handleDelete } = useSessionActions({
    sessionRuns, selectedSessionId, selectedSessionIdRef, modelOperation, sessions, projects,
    refetchSessions: sessionsQuery.refetch, setSearchParams,
  })

  useEffect(() => () => sessionRuns.releaseForeground(), [sessionRuns])

  function selectSession(sessionId: string) {
    const session = queryClient.getQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'])?.find((session) => session.id === sessionId)
    if (session) setProjectCollapsed(projectSessionGroupKey(session.cwd), false)
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

  function submitPrompt(mode: 'follow_up' | 'steer' = 'follow_up', commandsChecked = false) {
    if (attachmentDraft.items.length && (attachmentDraft.busy || prompt.trimStart().startsWith('/'))) {
      const error = attachmentDraft.busy ? '请等待附件上传完成，或移除失败的附件。' : '带附件时暂不支持命令，请先移除附件。'
      if (isDraft) setDraftError(error); else setControlError(error)
      return
    }
    if (modelOperation.current?.sessionId === selectedSessionId) return
    setControlError(undefined)
    if (isDraft) return void submitDraft()
    if (!selectedSessionId || (!prompt.trim() && !attachmentDraft.items.length)) return
    if (!commandsChecked && /^\/[^\s/]+(?:\s|$)/.test(prompt.trim())) {
      const sessionId = selectedSessionId
      if (runningInputRequests.current.has(sessionId)) return
      const revision = useWorkspaceStore.getState().draftRevisions[sessionId]
      runningInputRequests.current.add(sessionId)
      setRunningInputSessions([...runningInputRequests.current])
      void (async () => {
        let sendAsPrompt = false
        try {
          const commands = await queryClient.fetchQuery({ queryKey: ['runtime-commands', sessionId], queryFn: () => sessionRuns.getCommands(sessionId), staleTime: 0 })
          const name = prompt.trim().match(/^\/([^\s/]+)/)?.[1]
          if (commands.some((command) => command.name === name && command.source === 'extension')) {
            await sessionRuns.executeExtensionCommand(sessionId, prompt)
            if (useWorkspaceStore.getState().draftRevisions[sessionId] === revision) setDraft(sessionId, '')
          } else {
            sendAsPrompt = selectedSessionIdRef.current === sessionId && useWorkspaceStore.getState().draftRevisions[sessionId] === revision
          }
        } catch (cause) { setControlError(cause instanceof Error ? cause.message : '插件命令执行失败', sessionId) }
        finally {
          runningInputRequests.current.delete(sessionId)
          setRunningInputSessions([...runningInputRequests.current])
        }
        if (sendAsPrompt) submitPrompt(mode, true)
      })()
      return
    }
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
    return sessionModels.openModels(refresh)
  }

  async function openThinking(refresh = false) {
    if (isDraft) { await loadDraftSettings(refresh); return }
    return sessionModels.openThinking(refresh)
  }

  async function changeModel(provider: string, modelId: string) {
    if (isDraft) return draft.changeModel(provider, modelId)
    return sessionModels.changeModel(provider, modelId)
  }

  async function changeThinkingLevel(level: string) {
    if (isDraft) return draft.changeThinkingLevel(level)
    return sessionModels.changeThinkingLevel(level)
  }

  return {
    attachmentDraft, selectedSessionId, selectedSession, sessionResolution, draftProject, isDraft, prompt, currentRun, activeTurn, currentModel: isDraft ? draftModel : currentModel, modelLabel: isDraft ? (draftModels.find((model) => model.provider === draftModel?.provider && model.id === draftModel?.id)?.name ?? draftModel?.id ?? '选择模型') : modelLabel, modelStatus: isDraft ? draftSettingsStatus : modelStatus, modelError: isDraft ? draftSettingsError : modelError, status, isActive, isStreaming,
    extensionStatus, extensionWidget, planStatus, planPolicy, runtimeStatus, runtimeStates, runs, projects, collapsedProjectKeys,
    navigationOrder, setNavigationOrder, setProjectCollapsed, setDraft, setDraftPrompt,
    mutatingSessionId, creatingDraft, draftError, controlError, models: isDraft ? draftModels : models, thinkingLevels: isDraft ? draftLevels : thinkingLevels, thinkingOpen, setThinkingOpen, thinkingStatus: isDraft ? draftSettingsStatus : thinkingStatus, thinkingError: isDraft ? draftSettingsError : thinkingError, thinkingFailure, currentThinkingLevel: isDraft ? draftThinking : runtimeDetails[selectedSessionId]?.thinkingLevel,
    sessionsQuery, projectsQuery, historyQuery, history, historyError, planTurnId, turnIndexQuery, navigationNotice, retryNavigation, pendingJump, jumpError, cancelTurnJump, finishTurnJump,
    selectSession, createBranch, startDraft, openProject, removeProject, submitPrompt, steerQueued, retrySteering, submittingInput, abortPrompt, openModels, openThinking, handleRename, handleDelete,
    readTurnPrompt, requestTurnJump, openProjectFolder, changeModel, changeThinkingLevel,
    loadEarlier, retryHistory,
  }
}
