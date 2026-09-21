import { type CSSProperties, type FormEvent, useEffect, useMemo, useState } from 'react'
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, CircleX, Menu, PanelRight, RefreshCw, Send, Square } from 'lucide-react'
import { useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import { sessionHistoryQueryKey } from './history.js'
import { applyNavigationOrder, navigationOrdersEqual, reconcileNavigationOrder } from './navigation-order.js'
import { SessionInspector } from './session-inspector.js'
import { SessionNavigation } from './session-navigation.js'
import type { SessionRunController } from './session-run-controller.js'
import { SessionTimeline } from './session-timeline.js'
import { type PromptStatus, useWorkspaceStore } from './workspace-store.js'
import { deleteSession, fetchHealth, fetchSessionHistory, fetchSessions, type HealthResponse, renameSession } from './workspace-api.js'
import { groupSessionsByProject, sessionStatusLabel, shortSessionId } from './workspace.js'

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
  const toggleProjectCollapsed = useWorkspaceStore((state) => state.toggleProjectCollapsed)
  const [mutatingSessionId, setMutatingSessionId] = useState<string>()
  const health = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
    retry: 1,
    staleTime: 5_000,
  })
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

  function selectSession(sessionId: string) {
    setSearchParams({ session: sessionId })
    setNavigationOpen(false)
  }

  async function refreshWorkspace() {
    await Promise.all([health.refetch(), sessionsQuery.refetch()])
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
      onToggleProject={toggleProjectCollapsed}
      projects={projects}
      runs={runs}
      selectedSessionId={selectedSessionId}
    />
  )
  const inspector = <SessionInspector run={currentRun} session={selectedSession} />

  return (
    <main className="min-h-svh bg-background text-foreground">
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
      </header>

      <div
        className="workspace-grid grid min-h-[calc(100svh-3.5rem)] md:min-h-svh"
        style={{ '--inspector-width': `${inspectorWidth}px`, '--navigation-width': `${navigationWidth}px` } as CSSProperties}
      >
        <aside className="hidden min-h-0 border-r bg-card/60 md:block">{navigation}</aside>
        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="border-b px-4 py-4 sm:px-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">当前会话</p>
                {selectedSession ? (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h1 className="font-mono text-base font-semibold">{shortSessionId(selectedSession.id)}</h1>
                    <StatusBadge status={status} />
                    <span className="font-mono text-xs text-muted-foreground">{selectedSession.cwd ?? 'cwd 不可用'}</span>
                  </div>
                ) : <h1 className="mt-2 text-lg font-semibold">选择一个会话</h1>}
              </div>
              <div aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
                <ConnectionStatus health={health} />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button aria-label="刷新会话列表" disabled={sessionsQuery.isFetching} onClick={() => void refreshWorkspace()} size="icon-sm" variant="ghost">
                      <RefreshCw aria-hidden="true" className={sessionsQuery.isFetching ? 'animate-spin' : ''} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>刷新会话列表</TooltipContent>
                </Tooltip>
                <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
                  <SheetTrigger asChild>
                    <Button aria-label="打开会话检查器" className="xl:hidden" size="icon-sm" variant="ghost"><PanelRight aria-hidden="true" /></Button>
                  </SheetTrigger>
                  <SheetContent className="p-0" side="right">
                    <SheetTitle className="sr-only">会话检查器</SheetTitle>
                    <SheetDescription className="sr-only">当前会话的运行摘要与元信息。</SheetDescription>
                    {inspector}
                  </SheetContent>
                </Sheet>
              </div>
            </div>
          </header>

          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
              <SessionTimeline error={historyQuery.isError} history={historyQuery.data} isLoading={historyQuery.isPending} onRetry={() => void historyQuery.refetch()} />
              <section className="border-b pb-6">
                {isActive && currentRun?.responseText && <pre aria-live="polite" className="mt-4 whitespace-pre-wrap break-words text-sm leading-6">{currentRun.responseText}</pre>}
                {currentRun?.error && (
                  <p className="mt-4 flex items-center gap-2 text-sm text-destructive" role="alert">
                    <CircleX aria-hidden="true" className="size-4" />
                    {currentRun.error}
                  </p>
                )}
              </section>

              <form className="grid gap-3" onSubmit={(event) => void submitPrompt(event)}>
                <label className="text-sm font-semibold" htmlFor="prompt">输入提示词</label>
                <Textarea
                  disabled={!selectedSession || isActive}
                  id="prompt"
                  maxLength={20_000}
                  onChange={(event) => selectedSessionId && setDraft(selectedSessionId, event.target.value)}
                  placeholder="向当前原生 Pi 会话发送提示词"
                  rows={5}
                  value={prompt}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={!selectedSession || prompt.trim().length === 0 || isActive} type="submit"><Send aria-hidden="true" data-icon="inline-start" />发送</Button>
                  {status === 'running' && <Button onClick={() => void abortPrompt()} type="button" variant="destructive"><Square aria-hidden="true" data-icon="inline-start" />停止生成</Button>}
                  {status === 'aborting' && <span className="text-sm text-muted-foreground">正在停止…</span>}
                </div>
              </form>
            </div>
          </ScrollArea>
        </section>
        <aside className="hidden min-h-0 border-l bg-card/60 xl:block">{inspector}</aside>
      </div>
    </main>
  )
}

function ConnectionStatus({ health }: { health: UseQueryResult<HealthResponse, Error> }) {
  const state = health.isError ? '不可用' : health.isFetching ? '重连中' : '已连接'
  const Icon = health.isError ? CircleX : health.isFetching ? RefreshCw : CircleCheck
  const color = health.isError ? 'text-destructive' : health.isFetching ? 'text-warning' : 'text-success'

  return <span className={`hidden items-center gap-1.5 sm:inline-flex ${color}`}><Icon aria-hidden="true" className={health.isFetching ? 'size-3 animate-spin' : 'size-3'} />{state}</span>
}

function StatusBadge({ status }: { status: PromptStatus }) {
  const color = status === 'running' || status === 'aborting' ? 'text-warning' : status === 'complete' ? 'text-success' : status === 'error' ? 'text-destructive' : 'text-muted-foreground'
  return <span className={`text-xs font-medium ${color}`}>{sessionStatusLabel(status)}</span>
}
