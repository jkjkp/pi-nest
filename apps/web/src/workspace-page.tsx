import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleX, Menu, PanelRight, Send, Settings, Square } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'

import { useComposerTextarea } from './composer-textarea.js'
import { sessionHistoryQueryKey } from './history.js'
import { applyNavigationOrder, navigationOrdersEqual, reconcileNavigationOrder } from './navigation-order.js'
import { SessionInspector } from './session-inspector.js'
import { SessionNavigation } from './session-navigation.js'
import type { SessionRunController } from './session-run-controller.js'
import { SessionTimeline } from './session-timeline.js'
import { useWorkspaceStore } from './workspace-store.js'
import { deleteSession, fetchSessionHistory, fetchSessions, renameSession } from './workspace-api.js'
import { extensionStatusLine, extensionWidgetText, groupSessionsByProject, runtimeStatusLabel, sessionDisplayName, sessionStatusLabel, shouldFollowLatest } from './workspace.js'

const emptySessions: Awaited<ReturnType<typeof fetchSessions>> = []

export function WorkspacePage({ sessionRuns }: { sessionRuns: SessionRunController }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const selectedSessionId = searchParams.get('session') ?? ''
  const drafts = useWorkspaceStore((state) => state.drafts)
  const extensionStatuses = useWorkspaceStore((state) => state.extensionStatuses)
  const extensionWidgets = useWorkspaceStore((state) => state.extensionWidgets)
  const collapsedProjectKeys = useWorkspaceStore((state) => state.collapsedProjectKeys)
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
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  const setNavigationOrder = useWorkspaceStore((state) => state.setNavigationOrder)
  const setProjectCollapsed = useWorkspaceStore((state) => state.setProjectCollapsed)
  const [mutatingSessionId, setMutatingSessionId] = useState<string>()
  const [controlOpen, setControlOpen] = useState(false)
  const [controlError, setControlError] = useState<string>()
  const [models, setModels] = useState<{ id: string; name?: string; provider: string }[]>([])
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([])
  const [queueMode, setQueueMode] = useState<'follow_up' | 'steer'>('steer')
  const [followLatest, setFollowLatest] = useState(true)
  const [scrollViewport, setScrollViewport] = useState<HTMLElement | null>(null)
  const [inspectorSheetOpen, setInspectorSheetOpen] = useState(false)
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
  const prompt = drafts[selectedSessionId] ?? ''
  const promptTextareaRef = useComposerTextarea(prompt)
  const sourceProjects = useMemo(() => groupSessionsByProject(sessions), [sessions])
  const projects = useMemo(() => applyNavigationOrder(sourceProjects, navigationOrder), [navigationOrder, sourceProjects])

  useEffect(() => {
    if (sessions.length === 0 || sessions.some((session) => session.id === selectedSessionId)) return

    setSearchParams({ session: sessions[0].id }, { replace: true })
  }, [selectedSessionId, sessions, setSearchParams])

  useEffect(() => {
    const reconciled = reconcileNavigationOrder(navigationOrder, sourceProjects)
    if (!navigationOrdersEqual(navigationOrder, reconciled)) setNavigationOrder(reconciled)
  }, [navigationOrder, setNavigationOrder, sourceProjects])

  const setMessageScrollArea = useCallback((node: HTMLDivElement | null) => {
    messageScrollAreaRef.current = node
    setScrollViewport(node?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null)
  }, [setScrollViewport])

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
    if (!selectedSessionId) return
    sessionRuns.openSession(selectedSessionId)
  }, [selectedSessionId, sessionRuns])

  useEffect(() => () => sessionRuns.releaseForeground(), [sessionRuns])

  useEffect(() => {
    const media = window.matchMedia('(min-width: 80rem)')
    const closeSheetOnDesktop = () => { if (media.matches) setInspectorSheetOpen(false) }
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
    setSearchParams({ session: sessionId })
    setNavigationOpen(false)
  }

  function toggleInspector() {
    inspectorToggleScrollTop.current = scrollViewport?.scrollTop
    setInspectorOpen(!inspectorOpen)
  }

  function submitPrompt() {
    if (!selectedSessionId || prompt.trim().length === 0) return
    setFollowLatest(true)
    if (!isActive) {
      if (sessionRuns.start({ prompt, sessionId: selectedSessionId })) setDraft(selectedSessionId, '')
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
      onProjectOrderChange={(projectOrder) => setNavigationOrder({ ...navigationOrder, projectOrder })}
      onRename={handleRename}
      onSelect={selectSession}
      onSessionOrderChange={(projectKey, sessionOrder) =>
        setNavigationOrder({
          ...navigationOrder,
          sessionOrderByProject: { ...navigationOrder.sessionOrderByProject, [projectKey]: sessionOrder },
        })
      }
      onToggleProject={setProjectCollapsed}
      projects={projects}
      runs={runs}
      selectedSessionId={selectedSessionId}
    />
  )
  const inspector = <SessionInspector run={currentRun} session={selectedSession} />

  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-card px-3 sm:px-4">
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

      <div
        className="workspace-grid grid min-h-0 flex-1"
        style={{ '--inspector-width': `${inspectorWidth}px`, '--navigation-width': `${navigationWidth}px`, '--side-panel-width': inspectorOpen ? `${inspectorWidth}px` : '0px' } as CSSProperties}
      >
        <aside className="hidden min-h-0 border-r bg-card/60 md:block">{navigation}</aside>
        <section className="flex min-h-0 min-w-0 flex-col">
          <div className="min-h-0 flex-1" ref={setMessageScrollArea}>
            <ScrollArea className="h-full">
              <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-6 sm:px-6">
                <SessionTimeline
                  error={historyQuery.isError}
                  history={isActive ? undefined : historyQuery.data}
                  isLoading={!isActive && historyQuery.isPending}
                  isRunning={isActive}
                  onJumpToTurn={jumpToTurn}
                  onRetry={() => void historyQuery.refetch()}
                  scrollViewport={scrollViewport}
                  systemEvents={currentRun?.systemEvents}
                  turns={currentRun?.turns}
                />
                <section className="space-y-3">
                  {extensionWidget ? <pre className="rounded border bg-muted p-2 text-xs">{extensionWidget}</pre> : null}
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
                </section>
              </div>
            </ScrollArea>
          </div>
            <div className="mx-auto mb-4 flex min-h-[100px] w-[calc(100%-2rem)] max-w-[920px] shrink-0 flex-col justify-between gap-1 rounded-[2.5rem] border bg-muted/80 px-5 py-3 shadow-[0_16px_32px_rgb(0_0_0_/_0.12)] dark:border-white/10 dark:bg-[#303030] sm:w-[calc(100%-3rem)] sm:px-6">
              <label className="sr-only" htmlFor="prompt">向当前 Pi 会话发送提示词</label>
              <Textarea
                className="min-h-0! shrink-0 resize-none border-0 bg-transparent px-0 py-0 text-[16px] leading-7 shadow-none placeholder:text-muted-foreground/70 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
                disabled={!selectedSession}
                id="prompt"
                maxLength={20_000}
                onChange={(event) => selectedSessionId && setDraft(selectedSessionId, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return

                  event.preventDefault()
                  submitPrompt()
                }}
                placeholder="Enter 发送，Shift + Enter 换行"
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
                    <Button aria-label="发送提示词" className="rounded-full" disabled={!selectedSession || prompt.trim().length === 0} onClick={() => submitPrompt()} size="icon-lg" type="button"><Send aria-hidden="true" /></Button>
                  )}
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
