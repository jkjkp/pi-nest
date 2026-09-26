import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleX, Menu, PanelRight, Send, Settings, Square } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'

import { useComposerTextarea } from './composer-textarea.js'
import { historyUserTurnCount, sessionHistoryQueryKey } from './history.js'
import { applyNavigationOrder, navigationOrdersEqual, reconcileNavigationOrder } from './navigation-order.js'
import { SessionInspector } from './session-inspector.js'
import { SessionNavigation } from './session-navigation.js'
import type { SessionRunController } from './session-run-controller.js'
import { SessionTimeline } from './session-timeline.js'
import { useWorkspaceStore } from './workspace-store.js'
import { createSession, deleteSession, fetchSessionHistory, fetchSessions, renameSession, revealProjectInFinder } from './workspace-api.js'
import { extensionStatusLine, extensionWidgetText, groupSessionsByProject, runtimeStatusLabel, sessionDisplayName, sessionStatusLabel, shouldFollowLatest, type ProjectSessionGroup } from './workspace.js'

const emptySessions: Awaited<ReturnType<typeof fetchSessions>> = []

export function WorkspacePage({ sessionRuns }: { sessionRuns: SessionRunController }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const selectedSessionId = searchParams.get('session') ?? ''
  const draftProjectKey = searchParams.get('draftProject') ?? ''
  const drafts = useWorkspaceStore((state) => state.drafts)
  const extensionStatuses = useWorkspaceStore((state) => state.extensionStatuses)
  const extensionWidgets = useWorkspaceStore((state) => state.extensionWidgets)
  const collapsedProjectKeys = useWorkspaceStore((state) => state.collapsedProjectKeys)
  const hiddenProjectCwds = useWorkspaceStore((state) => state.hiddenProjectCwds)
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen)
  const inspectorWidth = useWorkspaceStore((state) => state.inspectorWidth)
  const navigationOpen = useWorkspaceStore((state) => state.navigationOpen)
  const navigationWidth = useWorkspaceStore((state) => state.navigationWidth)
  const runs = useWorkspaceStore((state) => state.runs)
  const runtimeStates = useWorkspaceStore((state) => state.runtimeStates)
  const watchStates = useWorkspaceStore((state) => state.watchStates)
  const setDraft = useWorkspaceStore((state) => state.setDraft)
  const navigationOrder = useWorkspaceStore((state) => state.navigationOrder)
  const setInspectorOpen = useWorkspaceStore((state) => state.setInspectorOpen)
  const hideProject = useWorkspaceStore((state) => state.hideProject)
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  const setNavigationOrder = useWorkspaceStore((state) => state.setNavigationOrder)
  const setProjectCollapsed = useWorkspaceStore((state) => state.setProjectCollapsed)
  const restoreProject = useWorkspaceStore((state) => state.restoreProject)
  const [mutatingSessionId, setMutatingSessionId] = useState<string>()
  const [controlOpen, setControlOpen] = useState(false)
  const [controlError, setControlError] = useState<string>()
  const [draftError, setDraftError] = useState<string>()
  const [draftPrompt, setDraftPrompt] = useState('')
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [models, setModels] = useState<{ id: string; name?: string; provider: string }[]>([])
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([])
  const [queueMode, setQueueMode] = useState<'follow_up' | 'steer'>('steer')
  const [followLatest, setFollowLatest] = useState(true)
  const [railOverlay, setRailOverlay] = useState<HTMLElement | null>(null)
  const [scrollViewport, setScrollViewport] = useState<HTMLElement | null>(null)
  const [inspectorSheetOpen, setInspectorSheetOpen] = useState(false)
  const [desktopInspectorSheetOpen, setDesktopInspectorSheetOpen] = useState(false)
  const messageScrollAreaRef = useRef<HTMLDivElement>(null)
  const navigationInProgress = useRef(false)
  const navigationFallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inspectorToggleScrollTop = useRef<number | undefined>(undefined)
  const previouslyScrolledSessionId = useRef(selectedSessionId)
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const sessions = sessionsQuery.data ?? emptySessions
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
  const currentRun = selectedSessionId ? runs[selectedSessionId] : undefined
  const modelLabel = currentRun?.model ?? '当前模型不可用'
  const status = currentRun?.status ?? 'idle'
  const isActive = status === 'running' || status === 'aborting'
  const extensionStatus = extensionStatusLine(extensionStatuses[selectedSessionId])
  const extensionWidget = extensionWidgetText(extensionWidgets[selectedSessionId])
  const runtimeStatus = runtimeStatusLabel(runtimeStates[selectedSessionId], isActive)
  const historyQuery = useQuery({
    enabled: Boolean(selectedSession) && watchStates[selectedSessionId] === 'ready' && !isActive && runtimeStates[selectedSessionId]?.lifecycle !== 'active' && runtimeStates[selectedSessionId]?.lifecycle !== 'loading',
    queryKey: sessionHistoryQueryKey(selectedSessionId),
    queryFn: () => fetchSessionHistory(selectedSessionId),
    retry: false,
  })
  const historyTurnCount = historyQuery.data ? historyUserTurnCount(historyQuery.data.entries) : undefined
  const sourceProjects = useMemo(() => groupSessionsByProject(sessions), [sessions])
  const orderedProjects = useMemo(() => applyNavigationOrder(sourceProjects, navigationOrder), [navigationOrder, sourceProjects])
  const projects = useMemo(() => orderedProjects.filter((project) => !project.cwd || !hiddenProjectCwds[project.cwd]), [hiddenProjectCwds, orderedProjects])
  const removedProjects = useMemo(() => orderedProjects.filter((project) => Boolean(project.cwd && hiddenProjectCwds[project.cwd])), [hiddenProjectCwds, orderedProjects])
  const draftProject = !selectedSessionId ? projects.find((project) => project.key === draftProjectKey) : undefined
  const isDraft = Boolean(draftProject)
  const prompt = isDraft ? draftPrompt : drafts[selectedSessionId] ?? ''
  const promptTextareaRef = useComposerTextarea(prompt)

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

  const setMessageScrollArea = useCallback((node: HTMLDivElement | null) => {
    messageScrollAreaRef.current = node
    setScrollViewport(node?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null)
  }, [setScrollViewport])

  const setRailOverlayRoot = useCallback((node: HTMLDivElement | null) => setRailOverlay(node), [setRailOverlay])

  useEffect(() => {
    if (!scrollViewport) return
    const updateFollowLatest = () => setFollowLatest(shouldFollowLatest(scrollViewport.scrollHeight, scrollViewport.scrollTop, scrollViewport.clientHeight, navigationInProgress.current))
    const completeNavigation = () => {
      clearTimeout(navigationFallback.current)
      navigationFallback.current = undefined
      navigationInProgress.current = false
      updateFollowLatest()
    }
    const handleScroll = () => {
      updateFollowLatest()
      if (!navigationInProgress.current) return
      clearTimeout(navigationFallback.current)
      navigationFallback.current = setTimeout(completeNavigation, 150)
    }
    scrollViewport.addEventListener('scroll', handleScroll, { passive: true })
    scrollViewport.addEventListener('scrollend', completeNavigation)
    return () => {
      clearTimeout(navigationFallback.current)
      scrollViewport.removeEventListener('scroll', handleScroll)
      scrollViewport.removeEventListener('scrollend', completeNavigation)
    }
  }, [scrollViewport])

  useLayoutEffect(() => {
    const selectedSessionChanged = previouslyScrolledSessionId.current !== selectedSessionId
    previouslyScrolledSessionId.current = selectedSessionId
    if (!followLatest && !selectedSessionChanged) return
    const frame = requestAnimationFrame(() => {
      if (scrollViewport) scrollViewport.scrollTop = scrollViewport.scrollHeight
    })

    return () => cancelAnimationFrame(frame)
  }, [currentRun?.error, currentRun?.systemEvents, currentRun?.turns, followLatest, historyQuery.data, scrollViewport, selectedSessionId])

  useEffect(() => {
    if (!selectedSession) return
    sessionRuns.openSession(selectedSessionId)
  }, [selectedSession, selectedSessionId, sessionRuns])

  useEffect(() => () => sessionRuns.releaseForeground(), [sessionRuns])

  useEffect(() => {
    const media = window.matchMedia('(min-width: 80rem)')
    const closeSheetOnDesktop = () => {
      if (!media.matches) return
      setInspectorSheetOpen(false)
      setDesktopInspectorSheetOpen(false)
    }
    closeSheetOnDesktop()
    media.addEventListener('change', closeSheetOnDesktop)
    return () => media.removeEventListener('change', closeSheetOnDesktop)
  }, [])

  useLayoutEffect(() => {
    if (inspectorToggleScrollTop.current === undefined || !scrollViewport) return
    scrollViewport.scrollTo({ top: inspectorToggleScrollTop.current })
    inspectorToggleScrollTop.current = undefined
  }, [inspectorOpen, scrollViewport])

  function selectSession(sessionId: string) {
    setFollowLatest(true)
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
    setFollowLatest(true)
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

  function toggleInspector() {
    inspectorToggleScrollTop.current = scrollViewport?.scrollTop
    setInspectorOpen(!inspectorOpen)
  }

  function submitPrompt() {
    if (isDraft) return void submitDraft()
    if (!selectedSessionId || prompt.trim().length === 0) return
    setFollowLatest(true)
    if (!isActive) {
      if (sessionRuns.start({ historyTurnCount, prompt, sessionId: selectedSessionId })) setDraft(selectedSessionId, '')
    }
    else void (queueMode === 'steer' ? sessionRuns.steer(selectedSessionId, prompt) : sessionRuns.followUp(selectedSessionId, prompt)).then(() => setDraft(selectedSessionId, '')).catch((cause) => setControlError(cause instanceof Error ? cause.message : 'Pi 控制命令失败'))
  }

  function jumpToTurn(turnId: string) {
    if (!scrollViewport) return
    const target = [...(messageScrollAreaRef.current?.querySelectorAll<HTMLElement>('[data-turn-id]') ?? [])].find((element) => element.dataset.turnId === turnId)
    if (!target) return
    setFollowLatest(false)
    const offset = target.getBoundingClientRect().top - scrollViewport.getBoundingClientRect().top
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    const top = Math.max(0, scrollViewport.scrollTop + offset - 16)
    if (behavior === 'smooth' && Math.abs(scrollViewport.scrollTop - top) > 1) navigationInProgress.current = true
    scrollViewport.scrollTo({ behavior, top })
  }

  function abortPrompt() {
    if (!selectedSessionId || status !== 'running') return
    void sessionRuns.stop(selectedSessionId)
  }

  async function openControls() {
    if (!selectedSessionId) return
    setControlError(undefined)
    setControlOpen(true)
    try {
      await sessionRuns.resumeRuntime(selectedSessionId)
      const [state, availableModels, levels] = await Promise.all([
        sessionRuns.getRuntimeState(selectedSessionId), sessionRuns.getAvailableModels(selectedSessionId), sessionRuns.getAvailableThinkingLevels(selectedSessionId),
      ])
      setModels(availableModels)
      setThinkingLevels(levels)
      if (state.model?.id && state.model.provider) useWorkspaceStore.getState().updateRun(selectedSessionId, { model: `${state.model.provider}/${state.model.id}` })
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

  const navigation = (
    <SessionNavigation
      collapsedProjectKeys={collapsedProjectKeys}
      error={sessionsQuery.error}
      isLoading={sessionsQuery.isPending}
      mutationSessionId={mutatingSessionId}
      onDelete={handleDelete}
      onNewConversation={startDraft}
      onProjectOrderChange={(projectOrder) => setNavigationOrder({ ...navigationOrder, projectOrder })}
      onRemoveProject={removeProject}
      onRename={handleRename}
      onRestoreProject={restoreProject}
      onRevealProject={revealProjectInFinder}
      onSelect={selectSession}
      onSessionOrderChange={(projectKey, sessionOrder) =>
        setNavigationOrder({
          ...navigationOrder,
          sessionOrderByProject: { ...navigationOrder.sessionOrderByProject, [projectKey]: sessionOrder },
        })
      }
      onToggleProject={setProjectCollapsed}
      projects={projects}
      removedProjects={removedProjects}
      runs={runs}
      selectedSessionId={selectedSessionId}
    />
  )
  const inspector = <SessionInspector run={currentRun} session={selectedSession} />

  return (
    <main className="relative flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-card px-3 sm:px-4 md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
            <SheetTrigger asChild>
              <Button aria-label="打开会话导航" className="md:hidden" size="icon-sm" variant="ghost"><Menu aria-hidden="true" /></Button>
            </SheetTrigger>
            <SheetContent className="p-0" side="left">
              <SheetTitle className="sr-only">会话导航</SheetTitle>
              <SheetDescription className="sr-only">选择要查看的 Pi 原生会话。</SheetDescription>
              {navigation}
            </SheetContent>
          </Sheet>
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">PN</span>
          <h1 className="truncate text-sm font-semibold tracking-tight" title={selectedSession ? sessionDisplayName(selectedSession) : undefined}>{selectedSession ? sessionDisplayName(selectedSession) : 'Pi Nest'}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {selectedSession && <Button asChild size="sm" variant="ghost"><Link to={`/settings?session=${encodeURIComponent(selectedSession.id)}`}><Settings aria-hidden="true" />设置</Link></Button>}
          <Sheet open={inspectorSheetOpen} onOpenChange={setInspectorSheetOpen}>
            <SheetTrigger asChild>
              <Button aria-label="打开会话检查器" className="xl:hidden" size="icon-sm" variant="ghost"><PanelRight aria-hidden="true" /></Button>
            </SheetTrigger>
            <SheetContent className="p-0" side="right">
              <SheetTitle className="sr-only">会话检查器</SheetTitle>
              <SheetDescription className="sr-only">当前会话的运行摘要与元信息。</SheetDescription>
              {inspector}
            </SheetContent>
          </Sheet>
          <Button aria-label={inspectorOpen ? '收起会话检查器' : '展开会话检查器'} className="hidden xl:inline-flex" onClick={toggleInspector} onPointerDown={(event) => event.preventDefault()} size="icon-sm" type="button" variant="ghost"><PanelRight aria-hidden="true" /></Button>
        </div>
      </header>

      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden h-14 items-center justify-end px-3 sm:px-4 md:flex">
        <Sheet open={desktopInspectorSheetOpen} onOpenChange={setDesktopInspectorSheetOpen}>
          <SheetTrigger asChild>
            <Button aria-label="打开会话检查器" className="pointer-events-auto xl:hidden" size="icon-sm" variant="ghost"><PanelRight aria-hidden="true" /></Button>
          </SheetTrigger>
          <SheetContent className="p-0" side="right">
            <SheetTitle className="sr-only">会话检查器</SheetTitle>
            <SheetDescription className="sr-only">当前会话的运行摘要与元信息。</SheetDescription>
            {inspector}
          </SheetContent>
        </Sheet>
        <Button aria-label={inspectorOpen ? '收起会话检查器' : '展开会话检查器'} className="pointer-events-auto hidden xl:inline-flex" onClick={toggleInspector} onPointerDown={(event) => event.preventDefault()} size="icon-sm" type="button" variant="ghost"><PanelRight aria-hidden="true" /></Button>
      </div>

      <div
        className="workspace-grid grid min-h-0 flex-1"
        style={{ '--inspector-width': `${inspectorWidth}px`, '--navigation-width': `${navigationWidth}px`, '--side-panel-width': inspectorOpen ? `${inspectorWidth}px` : '0px' } as CSSProperties}
      >
        <aside className="hidden min-h-0 border-r bg-card/60 md:block">{navigation}</aside>
        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="min-h-14 shrink-0 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
            <div className="conversation-stage min-h-14">
              <div className="conversation-stage-content flex min-w-0 items-center py-2 pr-12">
                <h1 className="truncate text-base font-semibold" title={selectedSession ? sessionDisplayName(selectedSession) : undefined}>{selectedSession ? sessionDisplayName(selectedSession) : draftProject ? `新对话 · ${draftProject.name}` : '选择一个会话'}</h1>
                {selectedSession && <Button asChild className="ml-auto" size="sm" variant="ghost"><Link to={`/settings?session=${encodeURIComponent(selectedSession.id)}`}><Settings aria-hidden="true" />设置</Link></Button>}
              </div>
            </div>
          </header>
          <div className="relative min-h-0 flex-1" ref={setMessageScrollArea}>
            <ScrollArea className="h-full">
              <div className="w-full space-y-4 px-4 py-6 sm:px-6">
                {isDraft ? (
                  <div className="conversation-stage py-16">
                    <section className="conversation-stage-content grid min-h-56 place-items-center rounded-2xl border border-dashed bg-muted/20 p-8 text-center">
                      <div className="space-y-2"><h2 className="text-lg font-semibold">在 {draftProject?.name} 开始新对话</h2><p className="text-sm text-muted-foreground">发送第一条消息后才会创建 Pi 会话。</p></div>
                    </section>
                  </div>
                ) : selectedSession ? <SessionTimeline
                  error={historyQuery.isError}
                  history={historyQuery.data}
                  isLoading={!isActive && historyQuery.isPending}
                  isRunning={isActive}
                  onJumpToTurn={jumpToTurn}
                  onRetry={() => void historyQuery.refetch()}
                  overlayRoot={railOverlay}
                  scrollViewport={scrollViewport}
                  systemEvents={currentRun?.systemEvents}
                  turns={currentRun?.turns}
                /> : <div className="conversation-stage py-16"><p className="conversation-stage-content text-center text-sm text-muted-foreground">从左侧选择一个会话，或在项目中创建新对话。</p></div>}
                <div className="conversation-stage">
                  <section className="conversation-stage-content space-y-3">
                    {!isDraft && extensionWidget ? <pre className="rounded border bg-muted p-2 text-xs">{extensionWidget}</pre> : null}
                    {isActive && (
                      <div aria-live="polite">
                        <p className="text-xs font-medium text-warning">{sessionStatusLabel(status)}</p>
                      </div>
                    )}
                    {currentRun?.error && (
                      <p className="flex items-center gap-2 rounded-lg border border-destructive/30 border-l-2 border-l-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                        <CircleX aria-hidden="true" className="size-4" />
                        {currentRun.error}
                      </p>
                    )}
                    {!currentRun?.error && runtimeStatus && <p className="text-xs text-muted-foreground" role={runtimeStates[selectedSessionId]?.lifecycle === 'failed' ? 'alert' : undefined}>{runtimeStatus}</p>}
                    {controlError && <p className="text-xs text-destructive" role="alert">{controlError}</p>}
                    {draftError && <p className="text-xs text-destructive" role="alert">{draftError}</p>}
                  </section>
                </div>
              </div>
            </ScrollArea>
            <div className="pointer-events-none absolute inset-0 z-10 px-4 sm:px-6">
              <div className="conversation-stage relative h-full" ref={setRailOverlayRoot} />
            </div>
          </div>
          <div className="shrink-0 px-4 sm:px-6">
            <div className="conversation-stage mb-4">
              <div className="conversation-stage-content">
                <div className="flex min-h-[100px] w-full flex-col justify-between gap-1 rounded-[2.5rem] border bg-muted/80 px-5 py-3 shadow-[0_16px_32px_rgb(0_0_0_/_0.12)] dark:border-white/10 dark:bg-[#303030] sm:px-6">
              <label className="sr-only" htmlFor="prompt">{isDraft ? '输入新对话的第一条提示词' : '向当前 Pi 会话发送提示词'}</label>
              <Textarea
                className="min-h-0! shrink-0 resize-none border-0 bg-transparent px-0 py-0 text-[16px] leading-7 shadow-none placeholder:text-muted-foreground/70 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
                disabled={(!selectedSession && !isDraft) || creatingDraft}
                id="prompt"
                maxLength={20_000}
                onChange={(event) => isDraft ? setDraftPrompt(event.target.value) : selectedSessionId && setDraft(selectedSessionId, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return

                  event.preventDefault()
                  submitPrompt()
                }}
                placeholder={isDraft ? '随心输入…' : 'Enter 发送，Shift + Enter 换行'}
                ref={promptTextareaRef}
                rows={1}
                style={{ lineHeight: '1.75rem' }}
                value={prompt}
              />
              <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2">
                {extensionStatus && <span className="text-xs text-muted-foreground">{extensionStatus}</span>}
                {isActive && <div className="flex gap-1 text-xs"><Button onClick={() => setQueueMode('steer')} size="sm" type="button" variant={queueMode === 'steer' ? 'secondary' : 'ghost'}>Steer</Button><Button onClick={() => setQueueMode('follow_up')} size="sm" type="button" variant={queueMode === 'follow_up' ? 'secondary' : 'ghost'}>Follow-up</Button></div>}
                <div className="ml-auto flex items-center gap-2">
                  <Button aria-label="Pi 运行控制" className="hidden max-w-48 text-foreground sm:inline-flex" disabled={!selectedSession || isActive} onClick={() => void openControls()} size="sm" type="button" variant="ghost">
                    <span className="truncate">{modelLabel}</span>
                    <ChevronDown aria-hidden="true" className="text-muted-foreground" />
                  </Button>
                  {status === 'running' && <Button aria-label="停止生成" className="rounded-full" onClick={() => void abortPrompt()} size="icon-lg" type="button" variant="destructive"><Square aria-hidden="true" /></Button>}
                  {status === 'aborting' && <span className="text-sm text-muted-foreground">正在停止…</span>}
                  {status === 'running' && <Button aria-label={queueMode === 'steer' ? '发送 Steer' : '发送 Follow-up'} className="rounded-full" disabled={prompt.trim().length === 0} onClick={() => submitPrompt()} size="icon-lg" type="button"><Send aria-hidden="true" /></Button>}
                  {status !== 'running' && status !== 'aborting' && (
                    <Button aria-label="发送提示词" className="rounded-full" disabled={(!selectedSession && !isDraft) || creatingDraft || prompt.trim().length === 0} onClick={() => submitPrompt()} size="icon-lg" type="button"><Send aria-hidden="true" /></Button>
                  )}
                </div>
                </div>
                </div>
              </div>
            </div>
          </div>
          <Sheet open={controlOpen} onOpenChange={setControlOpen}>
            <SheetContent className="space-y-5 overflow-y-auto" side="right">
              <SheetTitle>Pi 运行控制</SheetTitle>
              <SheetDescription>直接发送原生 Pi CLI RPC 控制命令。</SheetDescription>
              {controlError && <p className="text-sm text-destructive">{controlError}</p>}
              <div className="space-y-2"><p className="text-sm font-medium">模型</p>{models.map((model) => <Button className="w-full justify-start" key={`${model.provider}:${model.id}`} onClick={() => selectedSessionId && void sessionRuns.setModel(selectedSessionId, model.provider, model.id).then(() => setControlOpen(false)).catch((cause) => setControlError(cause instanceof Error ? cause.message : '模型切换失败'))} variant="outline">{model.name ?? `${model.provider}/${model.id}`}</Button>)}</div>
              <div className="space-y-2"><p className="text-sm font-medium">Thinking</p>{thinkingLevels.map((level) => <Button key={level} onClick={() => selectedSessionId && void sessionRuns.setThinkingLevel(selectedSessionId, level).then(() => setControlOpen(false)).catch((cause) => setControlError(cause instanceof Error ? cause.message : 'Thinking 切换失败'))} variant="outline">{level}</Button>)}</div>
              <Button disabled={isActive} onClick={() => selectedSessionId && void sessionRuns.compact(selectedSessionId).then(() => setControlOpen(false)).catch((cause) => setControlError(cause instanceof Error ? cause.message : '压缩失败'))} variant="secondary">压缩上下文</Button>
            </SheetContent>
          </Sheet>
        </section>
        <aside aria-hidden={!inspectorOpen} className={`hidden min-h-0 overflow-hidden bg-card/60 xl:block ${inspectorOpen ? 'border-l' : 'pointer-events-none'}`} inert={!inspectorOpen}>{inspector}</aside>
      </div>
    </main>
  )
}
