import { type CSSProperties, type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleX, Menu, PanelRight, Send, ShieldAlert, Square } from 'lucide-react'
import { useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'

import { sessionHistoryQueryKey } from './history.js'
import { applyNavigationOrder, navigationOrdersEqual, reconcileNavigationOrder } from './navigation-order.js'
import { SessionInspector } from './session-inspector.js'
import { SessionNavigation } from './session-navigation.js'
import type { SessionRunController } from './session-run-controller.js'
import { SessionTimeline } from './session-timeline.js'
import { useWorkspaceStore } from './workspace-store.js'
import { deleteSession, fetchSessionHistory, fetchSessions, renameSession } from './workspace-api.js'
import { groupSessionsByProject, sessionDisplayName, sessionStatusLabel } from './workspace.js'

const emptySessions: Awaited<ReturnType<typeof fetchSessions>> = []

export function WorkspacePage({ sessionRuns }: { sessionRuns: SessionRunController }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const selectedSessionId = searchParams.get('session') ?? ''
  const drafts = useWorkspaceStore((state) => state.drafts)
  const collapsedProjectKeys = useWorkspaceStore((state) => state.collapsedProjectKeys)
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen)
  const inspectorWidth = useWorkspaceStore((state) => state.inspectorWidth)
  const navigationOpen = useWorkspaceStore((state) => state.navigationOpen)
  const navigationWidth = useWorkspaceStore((state) => state.navigationWidth)
  const runs = useWorkspaceStore((state) => state.runs)
  const setDraft = useWorkspaceStore((state) => state.setDraft)
  const navigationOrder = useWorkspaceStore((state) => state.navigationOrder)
  const setInspectorOpen = useWorkspaceStore((state) => state.setInspectorOpen)
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  const setNavigationOrder = useWorkspaceStore((state) => state.setNavigationOrder)
  const setProjectCollapsed = useWorkspaceStore((state) => state.setProjectCollapsed)
  const [mutatingSessionId, setMutatingSessionId] = useState<string>()
  const messageScrollAreaRef = useRef<HTMLDivElement>(null)
  const sessionsQuery = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const sessions = sessionsQuery.data ?? emptySessions
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
  const currentRun = selectedSessionId ? runs[selectedSessionId] : undefined
  const status = currentRun?.status ?? 'idle'
  const isActive = status === 'running' || status === 'aborting'
  const historyQuery = useQuery({
    enabled: Boolean(selectedSession) && !isActive,
    queryKey: sessionHistoryQueryKey(selectedSessionId),
    queryFn: () => fetchSessionHistory(selectedSessionId),
    retry: false,
  })
  const prompt = drafts[selectedSessionId] ?? ''
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

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const viewport = messageScrollAreaRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    })

    return () => cancelAnimationFrame(frame)
  }, [currentRun?.error, currentRun?.responseText, historyQuery.data, selectedSessionId])

  function selectSession(sessionId: string) {
    setSearchParams({ session: sessionId })
    setNavigationOpen(false)
  }

  function submitPrompt(event: FormEvent) {
    event.preventDefault()
    if (!selectedSessionId || isActive || prompt.trim().length === 0) return
    sessionRuns.start({ prompt, sessionId: selectedSessionId })
  }

  function abortPrompt() {
    if (!selectedSessionId || status !== 'running') return
    void sessionRuns.stop(selectedSessionId)
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
    <main className="h-svh overflow-hidden bg-background text-foreground">
      <header className="flex min-h-14 items-center gap-3 border-b bg-card px-3 sm:px-4 md:hidden">
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
          <span className="truncate text-sm font-semibold tracking-tight">Pi Nest</span>
        </div>
        <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
          <SheetTrigger asChild>
            <Button aria-label="打开会话检查器" size="icon-sm" variant="ghost"><PanelRight aria-hidden="true" /></Button>
          </SheetTrigger>
          <SheetContent className="p-0" side="right">
            <SheetTitle className="sr-only">会话检查器</SheetTitle>
            <SheetDescription className="sr-only">当前会话的运行摘要与元信息。</SheetDescription>
            {inspector}
          </SheetContent>
        </Sheet>
      </header>

      <div
        className="workspace-grid grid h-[calc(100svh-3.5rem)] md:h-svh"
        style={{ '--inspector-width': `${inspectorWidth}px`, '--navigation-width': `${navigationWidth}px` } as CSSProperties}
      >
        <aside className="hidden min-h-0 border-r bg-card/60 md:block">{navigation}</aside>
        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="sticky top-0 z-10 flex min-h-14 items-center border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
            <h1 className="truncate text-base font-semibold" title={selectedSession ? sessionDisplayName(selectedSession) : undefined}>
              {selectedSession ? sessionDisplayName(selectedSession) : '选择一个会话'}
            </h1>
          </header>

          <div className="min-h-0 flex-1" ref={messageScrollAreaRef}>
            <ScrollArea className="h-full">
              <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-6 sm:px-6">
                <SessionTimeline error={historyQuery.isError} history={historyQuery.data} isLoading={historyQuery.isPending} onRetry={() => void historyQuery.refetch()} />
                <section className="space-y-3">
                  {isActive && (
                    <div aria-live="polite">
                      <p className="text-xs font-medium text-warning">{sessionStatusLabel(status)}</p>
                      {currentRun?.responseText ? (
                        <pre className="whitespace-pre-wrap break-words text-base leading-7">{currentRun.responseText}</pre>
                      ) : <p className="text-sm text-muted-foreground">正在等待回复…</p>}
                    </div>
                  )}
                  {currentRun?.error && (
                    <p className="flex items-center gap-2 rounded-lg border border-destructive/30 border-l-2 border-l-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                      <CircleX aria-hidden="true" className="size-4" />
                      {currentRun.error}
                    </p>
                  )}
                </section>
              </div>
            </ScrollArea>
          </div>
          <div className="shrink-0 bg-gradient-to-t from-background via-background to-transparent px-4 pb-4 pt-8 sm:px-6">
            <form className="mx-auto flex h-[100px] w-full max-w-[920px] flex-col gap-1 rounded-[2.5rem] border bg-muted/80 px-5 py-3 shadow-[0_16px_32px_rgb(0_0_0_/_0.12)] dark:border-white/10 dark:bg-[#303030] sm:px-6" onSubmit={(event) => void submitPrompt(event)}>
              <label className="sr-only" htmlFor="prompt">向当前 Pi 会话发送提示词</label>
              <Textarea
                className="min-h-0! flex-1 resize-none border-0 bg-transparent px-0 py-0 text-[16px] leading-7 shadow-none placeholder:text-muted-foreground/70 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
                disabled={!selectedSession || isActive}
                id="prompt"
                maxLength={20_000}
                onChange={(event) => selectedSessionId && setDraft(selectedSessionId, event.target.value)}
                placeholder="随心输入"
                rows={3}
                value={prompt}
              />
              <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm text-warning">
                  <ShieldAlert aria-hidden="true" className="size-4" />
                  工具：已禁用
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
                    <SheetTrigger asChild>
                      <Button aria-label="打开会话检查器" className="hidden md:inline-flex xl:hidden" size="icon-sm" variant="ghost"><PanelRight aria-hidden="true" /></Button>
                    </SheetTrigger>
                    <SheetContent className="p-0" side="right">
                      <SheetTitle className="sr-only">会话检查器</SheetTitle>
                      <SheetDescription className="sr-only">当前会话的运行摘要与元信息。</SheetDescription>
                      {inspector}
                    </SheetContent>
                  </Sheet>
                  {status === 'running' && <Button aria-label="停止生成" className="rounded-full" onClick={() => void abortPrompt()} size="icon-lg" type="button" variant="destructive"><Square aria-hidden="true" /></Button>}
                  {status === 'aborting' && <span className="text-sm text-muted-foreground">正在停止…</span>}
                  {status !== 'running' && status !== 'aborting' && (
                    <Button aria-label="发送提示词" className="rounded-full" disabled={!selectedSession || prompt.trim().length === 0} size="icon-lg" type="submit"><Send aria-hidden="true" /></Button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </section>
        <aside className="hidden min-h-0 border-l bg-card/60 xl:block">{inspector}</aside>
      </div>
    </main>
  )
}
