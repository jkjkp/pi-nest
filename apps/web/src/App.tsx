import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  GripVertical,
  Menu,
  MoreHorizontal,
  PanelRight,
  Pencil,
  RefreshCw,
  Send,
  Settings2,
  Square,
  Trash2,
} from 'lucide-react'
import { Navigate, Route, Routes, useSearchParams } from 'react-router'

import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import {
  sessionHistoryQueryKey,
  type PiSessionHistoryMessage,
  type PiSessionHistoryResponse,
} from './history.js'
import { applyNavigationOrder, navigationOrdersEqual, reconcileNavigationOrder } from './navigation-order.js'
import type { SessionRunController } from './session-run-controller.js'
import { type PromptStatus, type SessionRunSummary, useWorkspaceStore } from './workspace-store.js'
import {
  formatUpdatedAt,
  groupSessionsByProject,
  type PiSessionSummary,
  type ProjectSessionGroup,
  projectIsCollapsed,
  runInspectorFields,
  sessionDisplayName,
  sessionStatusLabel,
  shortSessionId,
} from './workspace.js'

type HealthResponse = { status?: string }
const emptySessions: PiSessionSummary[] = []

async function fetchJson<T>(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
  return (await response.json()) as T
}

function App({ sessionRuns }: { sessionRuns: SessionRunController }) {
  return (
    <TooltipProvider>
      <Routes>
        <Route path="/" element={<Workspace sessionRuns={sessionRuns} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TooltipProvider>
  )
}

function Workspace({ sessionRuns }: { sessionRuns: SessionRunController }) {
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
    queryFn: () => fetchJson<HealthResponse>('/api/health'),
    refetchInterval: 10_000,
    retry: 1,
    staleTime: 5_000,
  })
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      const body = await fetchJson<{ sessions?: PiSessionSummary[] }>('/api/sessions')
      if (!Array.isArray(body.sessions)) throw new Error('Invalid session list response')
      return body.sessions
    },
  })
  const sessions = sessionsQuery.data ?? emptySessions
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
  const currentRun = selectedSessionId ? runs[selectedSessionId] : undefined
  const status = currentRun?.status ?? 'idle'
  const isActive = status === 'running' || status === 'aborting'
  const historyQuery = useQuery({
    enabled: Boolean(selectedSession) && !isActive,
    queryKey: sessionHistoryQueryKey(selectedSessionId),
    queryFn: () => fetchJson<PiSessionHistoryResponse>(`/api/sessions/${encodeURIComponent(selectedSessionId)}/history`),
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

  async function renameSession(sessionId: string, name: string) {
    setMutatingSessionId(sessionId)
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        body: JSON.stringify({ name }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH',
      })
      if (!response.ok) throw new Error('Failed to rename Pi session')
      await sessionsQuery.refetch()
    } finally {
      setMutatingSessionId(undefined)
    }
  }

  async function deleteSession(sessionId: string) {
    setMutatingSessionId(sessionId)
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Failed to delete Pi session')
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
      onDelete={deleteSession}
      onSelect={selectSession}
      onToggleProject={toggleProjectCollapsed}
      onRename={renameSession}
      onProjectOrderChange={(projectOrder) =>
        setNavigationOrder({ ...navigationOrder, projectOrder })
      }
      onSessionOrderChange={(projectKey, sessionOrder) =>
        setNavigationOrder({
          ...navigationOrder,
          sessionOrderByProject: { ...navigationOrder.sessionOrderByProject, [projectKey]: sessionOrder },
        })
      }
      projects={projects}
      runs={runs}
      selectedSessionId={selectedSessionId}
    />
  )
  const inspector = <SessionInspector run={currentRun} session={selectedSession} />

  return (
    <main className="grid min-h-svh grid-rows-[auto_minmax(0,1fr)] bg-background text-foreground">
      <header className="flex min-h-14 items-center gap-3 border-b bg-card px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
            <SheetTrigger asChild>
              <Button aria-label="打开会话导航" className="md:hidden" size="icon-sm" variant="ghost">
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent className="p-0" side="left">
              <SheetTitle className="sr-only">会话导航</SheetTitle>
              <SheetDescription className="sr-only">选择要查看的 Pi 原生会话。</SheetDescription>
              {navigation}
            </SheetContent>
          </Sheet>
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            PN
          </span>
          <span className="truncate text-sm font-semibold tracking-tight">Pi Nest</span>
        </div>

        <div aria-live="polite" className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <ConnectionStatus health={health} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="刷新会话列表"
                disabled={sessionsQuery.isFetching}
                onClick={() => void refreshWorkspace()}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshCw aria-hidden="true" className={sessionsQuery.isFetching ? 'animate-spin' : ''} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>刷新会话列表</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button aria-label="设置暂不可用" disabled size="icon-sm" variant="ghost">
                  <Settings2 aria-hidden="true" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>设置将在后续版本提供</TooltipContent>
          </Tooltip>
          <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
            <SheetTrigger asChild>
              <Button aria-label="打开会话检查器" className="xl:hidden" size="icon-sm" variant="ghost">
                <PanelRight aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent className="p-0" side="right">
              <SheetTitle className="sr-only">会话检查器</SheetTitle>
              <SheetDescription className="sr-only">当前会话的运行摘要与元信息。</SheetDescription>
              {inspector}
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <div
        className="workspace-grid grid min-h-0"
        style={
          {
            '--inspector-width': `${inspectorWidth}px`,
            '--navigation-width': `${navigationWidth}px`,
          } as CSSProperties
        }
      >
        <aside className="hidden min-h-0 border-r bg-card/60 md:block">{navigation}</aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="border-b px-4 py-4 sm:px-6">
            <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">当前会话</p>
            {selectedSession ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="font-mono text-base font-semibold">{shortSessionId(selectedSession.id)}</h1>
                <StatusBadge status={status} />
                <span className="font-mono text-xs text-muted-foreground">{selectedSession.cwd ?? 'cwd 不可用'}</span>
              </div>
            ) : (
              <h1 className="mt-2 text-lg font-semibold">选择一个会话</h1>
            )}
          </header>

          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
              <SessionTimeline
                error={historyQuery.isError}
                history={historyQuery.data}
                isLoading={historyQuery.isPending}
                onRetry={() => void historyQuery.refetch()}
              />
              <section className="border-b pb-6">
                {isActive && currentRun?.responseText && (
                  <pre aria-live="polite" className="mt-4 whitespace-pre-wrap break-words text-sm leading-6">
                    {currentRun.responseText}
                  </pre>
                )}
                {currentRun?.error && (
                  <p className="mt-4 flex items-center gap-2 text-sm text-destructive" role="alert">
                    <CircleX aria-hidden="true" className="size-4" />
                    {currentRun.error}
                  </p>
                )}
              </section>

              <form className="grid gap-3" onSubmit={(event) => void submitPrompt(event)}>
                <label className="text-sm font-semibold" htmlFor="prompt">
                  输入提示词
                </label>
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
                  <Button disabled={!selectedSession || prompt.trim().length === 0 || isActive} type="submit">
                    <Send aria-hidden="true" data-icon="inline-start" />
                    发送
                  </Button>
                  {status === 'running' && (
                    <Button onClick={() => void abortPrompt()} type="button" variant="destructive">
                      <Square aria-hidden="true" data-icon="inline-start" />
                      停止生成
                    </Button>
                  )}
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

function SessionTimeline({
  error,
  history,
  isLoading,
  onRetry,
}: {
  error: boolean
  history: PiSessionHistoryResponse | undefined
  isLoading: boolean
  onRetry: () => void
}) {
  if (isLoading) {
    return (
      <section aria-label="正在加载会话历史" className="space-y-3">
        {Array.from({ length: 3 }, (_, index) => <Skeleton className="h-24" key={index} />)}
      </section>
    )
  }

  if (error) {
    return (
      <section className="border-b pb-6" role="alert">
        <h2 className="text-sm font-semibold">无法读取会话历史</h2>
        <p className="mt-2 text-sm text-muted-foreground">历史仍保留在本机原生会话中；请刷新后重试。</p>
        <Button className="mt-3" onClick={onRetry} size="sm" type="button" variant="secondary">
          重试
        </Button>
      </section>
    )
  }

  if (!history) return null

  if (history.entries.length === 0) {
    return (
      <section className="border-b pb-6">
        <h2 className="text-sm font-semibold">会话内容</h2>
        <p className="mt-2 text-sm text-muted-foreground">当前活动分支尚无可展示的消息。</p>
      </section>
    )
  }

  return (
    <section className="space-y-3 border-b pb-6">
      <h2 className="text-sm font-semibold">会话内容</h2>
      {history.hasEarlier && (
        <p className="text-xs text-muted-foreground">首版仅展示当前活动分支最近 200 条原生记录。</p>
      )}
      {history.entries.map((entry, index) =>
        entry.kind === 'omitted' ? (
          <div className="border-l-2 border-muted px-3 py-2 text-xs text-muted-foreground" key={`${entry.timestamp}-${index}`}>
            {entry.label}（连续 {entry.count} 条）
          </div>
        ) : (
          <TimelineMessage entry={entry} key={entry.id} />
        ),
      )}
    </section>
  )
}

function TimelineMessage({ entry }: { entry: PiSessionHistoryMessage }) {
  const assistant = entry.role === 'assistant'
  return (
    <article className={assistant ? 'border bg-card p-4' : 'border bg-muted/45 p-3'}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{assistant ? '助手' : '用户'}</span>
        <time dateTime={entry.timestamp}>{formatUpdatedAt(entry.timestamp)}</time>
      </header>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{entry.text}</p>
      {(entry.stopReason || entry.hasOmittedContent) && (
        <footer className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {entry.stopReason && <span>终止原因：{entry.stopReason}</span>}
          {entry.hasOmittedContent && <span>包含未展示的原生内容</span>}
        </footer>
      )}
    </article>
  )
}

function ConnectionStatus({ health }: { health: UseQueryResult<HealthResponse, Error> }) {
  const state = health.isError ? '不可用' : health.isFetching ? '重连中' : '已连接'
  const Icon = health.isError ? CircleX : health.isFetching ? RefreshCw : CircleCheck
  const color = health.isError ? 'text-destructive' : health.isFetching ? 'text-warning' : 'text-success'

  return (
    <span className={`hidden items-center gap-1.5 sm:inline-flex ${color}`}>
      <Icon aria-hidden="true" className={health.isFetching ? 'size-3 animate-spin' : 'size-3'} />
      {state}
    </span>
  )
}

function SessionNavigation({
  collapsedProjectKeys,
  error,
  isLoading,
  mutationSessionId,
  onDelete,
  onSelect,
  onRename,
  onProjectOrderChange,
  onSessionOrderChange,
  onToggleProject,
  projects,
  runs,
  selectedSessionId,
}: {
  collapsedProjectKeys: Record<string, boolean>
  error: Error | null
  isLoading: boolean
  mutationSessionId: string | undefined
  onDelete: (sessionId: string) => Promise<void>
  onSelect: (sessionId: string) => void
  onRename: (sessionId: string, name: string) => Promise<void>
  onProjectOrderChange: (projectOrder: string[]) => void
  onSessionOrderChange: (projectKey: string, sessionOrder: string[]) => void
  onToggleProject: (projectKey: string) => void
  projects: ProjectSessionGroup[]
  runs: Record<string, SessionRunSummary>
  selectedSessionId: string
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [renaming, setRenaming] = useState<PiSessionSummary>()
  const [renameValue, setRenameValue] = useState('')
  const [deleting, setDeleting] = useState<PiSessionSummary>()
  const [actionError, setActionError] = useState<string>()

  function requestRename(session: PiSessionSummary) {
    setActionError(undefined)
    setRenameValue(session.name ?? '')
    setRenaming(session)
  }

  async function confirmRename() {
    if (!renaming || renameValue.trim().length === 0) return
    try {
      await onRename(renaming.id, renameValue)
      setRenaming(undefined)
    } catch {
      setActionError('重命名失败，请刷新后重试。')
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    try {
      await onDelete(deleting.id)
      setDeleting(undefined)
    } catch {
      setActionError('删除失败，请刷新后重试。')
    }
  }

  function reorder(event: DragEndEvent) {
    const over = event.over
    const kind = event.active.data.current?.kind
    if (!over || event.active.id === over.id) return

    if (kind === 'project') {
      const activeIndex = projects.findIndex((project) => `project:${project.key}` === event.active.id)
      const overIndex = projects.findIndex((project) => `project:${project.key}` === over.id)
      if (activeIndex >= 0 && overIndex >= 0) onProjectOrderChange(arrayMove(projects.map((project) => project.key), activeIndex, overIndex))
      return
    }

    if (kind !== 'session' || event.active.data.current?.projectKey !== over.data.current?.projectKey) return
    const project = projects.find((candidate) => candidate.key === event.active.data.current?.projectKey)
    if (!project) return
    const activeIndex = project.sessions.findIndex((session) => `session:${session.id}` === event.active.id)
    const overIndex = project.sessions.findIndex((session) => `session:${session.id}` === over.id)
    if (activeIndex >= 0 && overIndex >= 0) {
      onSessionOrderChange(project.key, arrayMove(project.sessions.map((session) => session.id), activeIndex, overIndex))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-4">
        <h2 className="text-sm font-semibold">会话</h2>
        <p className="mt-1 text-xs text-muted-foreground">本机原生 Pi 会话</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {isLoading && Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-16" />)}
          {error && <p className="p-3 text-sm text-destructive">会话列表不可用</p>}
          {!isLoading && !error && projects.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">未发现本机 Pi 会话</p>
          )}
          <DndContext collisionDetection={closestCenter} onDragEnd={reorder} sensors={sensors}>
            <SortableContext items={projects.map((project) => `project:${project.key}`)} strategy={verticalListSortingStrategy}>
              {projects.map((project, index) => (
                <SortableProject
                  collapsed={projectIsCollapsed(collapsedProjectKeys, project.key)}
                  index={index}
                  key={project.key}
                  mutationSessionId={mutationSessionId}
                  onDelete={(session) => {
                    setActionError(undefined)
                    setDeleting(session)
                  }}
                  onRename={requestRename}
                  onSelect={onSelect}
                  onToggle={onToggleProject}
                  project={project}
                  runs={runs}
                  selectedSessionId={selectedSessionId}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </ScrollArea>
      <Dialog onOpenChange={(open) => !open && setRenaming(undefined)} open={Boolean(renaming)}>
        <DialogContent>
          <DialogTitle>重命名会话</DialogTitle>
          <DialogDescription>名称会作为 Pi 原生会话元数据保存，Pi CLI 也可读取。</DialogDescription>
          <label className="mt-4 grid gap-2 text-sm font-medium" htmlFor="session-name">
            会话名称
            <input
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              id="session-name"
              maxLength={120}
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder={renaming && !renaming.name ? sessionDisplayName(renaming) : '输入会话名称'}
              value={renameValue}
            />
          </label>
          {actionError && <p className="mt-3 text-sm text-destructive" role="alert">{actionError}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild><Button type="button" variant="secondary">取消</Button></DialogClose>
            <Button disabled={renameValue.trim().length === 0 || mutationSessionId === renaming?.id} onClick={() => void confirmRename()} type="button">
              保存名称
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog onOpenChange={(open) => !open && setDeleting(undefined)} open={Boolean(deleting)}>
        <AlertDialogContent>
          <AlertDialogTitle>删除原生 Pi 会话？</AlertDialogTitle>
          <AlertDialogDescription>
            将先移入系统废纸篓；若废纸篓不可用，会永久删除原生会话文件且无法恢复。
          </AlertDialogDescription>
          {actionError && <p className="mt-3 text-sm text-destructive" role="alert">{actionError}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogCancel asChild><Button type="button" variant="secondary">取消</Button></AlertDialogCancel>
            <Button disabled={mutationSessionId === deleting?.id} onClick={() => void confirmDelete()} type="button" variant="destructive">
              删除会话
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SortableProject({
  collapsed,
  index,
  mutationSessionId,
  onDelete,
  onRename,
  onSelect,
  onToggle,
  project,
  runs,
  selectedSessionId,
}: {
  collapsed: boolean
  index: number
  mutationSessionId: string | undefined
  onDelete: (session: PiSessionSummary) => void
  onRename: (session: PiSessionSummary) => void
  onSelect: (sessionId: string) => void
  onToggle: (projectKey: string) => void
  project: ProjectSessionGroup
  runs: Record<string, SessionRunSummary>
  selectedSessionId: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    data: { kind: 'project', projectKey: project.key },
    id: `project:${project.key}`,
  })
  const expanded = !collapsed
  const sessionListId = `project-sessions-${index}`
  const projectDescription = project.cwd ?? '工作目录不可用'

  return (
    <section
      className="space-y-1"
      ref={setNodeRef}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
    >
      <div className="flex items-center gap-1">
        <button
          aria-label={`拖动排序项目 ${project.name}`}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          type="button"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" className="size-3.5" />
        </button>
        <button
          aria-controls={sessionListId}
          aria-expanded={expanded}
          aria-label={`项目 ${project.name}，目录 ${projectDescription}，${project.sessions.length} 个会话，${expanded ? '已展开' : '已折叠'}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-semibold outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
          onClick={() => onToggle(project.key)}
          title={project.cwd}
          type="button"
        >
          <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          <span className="shrink-0 font-mono text-xs font-normal tabular-nums text-muted-foreground">{project.sessions.length}</span>
        </button>
      </div>
      {expanded && (
        <div className="space-y-1 border-l pl-2" id={sessionListId}>
          <SortableContext items={project.sessions.map((session) => `session:${session.id}`)} strategy={verticalListSortingStrategy}>
            {project.sessions.map((session) => (
              <SortableSession
                key={session.id}
                mutationSessionId={mutationSessionId}
                onDelete={onDelete}
                onRename={onRename}
                onSelect={onSelect}
                projectKey={project.key}
                run={runs[session.id]}
                selected={session.id === selectedSessionId}
                session={session}
              />
            ))}
          </SortableContext>
        </div>
      )}
    </section>
  )
}

function SortableSession({
  mutationSessionId,
  onDelete,
  onRename,
  onSelect,
  projectKey,
  run,
  selected,
  session,
}: {
  mutationSessionId: string | undefined
  onDelete: (session: PiSessionSummary) => void
  onRename: (session: PiSessionSummary) => void
  onSelect: (sessionId: string) => void
  projectKey: string
  run: SessionRunSummary | undefined
  selected: boolean
  session: PiSessionSummary
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    data: { kind: 'session', projectKey },
    id: `session:${session.id}`,
  })
  const status = run?.status ?? 'idle'
  const cannotDelete = selected || status === 'running' || status === 'aborting' || mutationSessionId === session.id

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="flex items-center gap-1"
          ref={setNodeRef}
          style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
        >
          <button
            aria-label={`拖动排序会话 ${sessionDisplayName(session)}`}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            type="button"
            {...attributes}
            {...listeners}
          >
            <GripVertical aria-hidden="true" className="size-3.5" />
          </button>
          <Button
            aria-current={selected ? 'page' : undefined}
            className="h-auto min-w-0 flex-1 justify-start px-3 py-2 text-left"
            onClick={() => onSelect(session.id)}
            variant={selected ? 'secondary' : 'ghost'}
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{sessionDisplayName(session)}</span>
            <MoreHorizontal aria-hidden="true" className="size-3.5 text-muted-foreground" />
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={mutationSessionId === session.id} onSelect={() => onRename(session)}>
          <Pencil aria-hidden="true" className="mr-2 size-3.5" />重命名
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive" disabled={cannotDelete} onSelect={() => onDelete(session)}>
          <Trash2 aria-hidden="true" className="mr-2 size-3.5" />删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function SessionInspector({ run, session }: { run: SessionRunSummary | undefined; session: PiSessionSummary | undefined }) {
  const status = run?.status ?? 'idle'
  const fields = runInspectorFields(run)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-4">
        <h2 className="text-sm font-semibold">会话检查器</h2>
        <p className="mt-1 text-xs text-muted-foreground">运行摘要与安全元信息</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 p-4 text-sm">
          <section aria-labelledby="inspector-runtime-heading" className="space-y-3">
            <h3 className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase" id="inspector-runtime-heading">
              运行
            </h3>
            <dl className="space-y-4">
              <InspectorItem label="运行状态">
                <StatusBadge status={status} />
              </InspectorItem>
              <InspectorItem label="本工作台文本增量事件">
                <InspectorCodeValue value={fields.textDeltaCount} />
              </InspectorItem>
              <InspectorItem label="终止原因">
                <InspectorCodeValue value={fields.stopReason} />
              </InspectorItem>
              <InspectorItem label="最近错误">
                {fields.error ? (
                  <span className="flex break-words gap-2 text-destructive">
                    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    {fields.error}
                  </span>
                ) : (
                  <InspectorUnavailable />
                )}
              </InspectorItem>
            </dl>
          </section>

          <section aria-labelledby="inspector-session-heading" className="space-y-3 border-t pt-5">
            <h3 className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase" id="inspector-session-heading">
              会话
            </h3>
            <dl className="space-y-4">
              <InspectorItem label="Session ID">
                <InspectorCodeValue value={session?.id ?? '未选择'} />
              </InspectorItem>
              <InspectorItem label="项目目录">
                <InspectorCodeValue value={session?.cwd ?? '当前不可用'} />
              </InspectorItem>
              <InspectorItem label="最近更新">{formatUpdatedAt(session?.updatedAt)}</InspectorItem>
              <InspectorItem label="模型">
                <InspectorCodeValue value={fields.model} />
              </InspectorItem>
              <InspectorItem label="Thinking">
                <InspectorUnavailable />
              </InspectorItem>
              <InspectorItem label="工具">受限模式：已禁用</InspectorItem>
            </dl>
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

function InspectorCodeValue({ value }: { value: string }) {
  return (
    <span className={`break-all font-mono text-xs tabular-nums ${value === '当前不可用' ? 'text-muted-foreground' : ''}`}>
      {value}
    </span>
  )
}

function InspectorUnavailable() {
  return <span className="text-muted-foreground">当前不可用</span>
}

function InspectorItem({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  )
}

function StatusBadge({ status }: { status: PromptStatus }) {
  const color =
    status === 'running' || status === 'aborting'
      ? 'text-warning'
      : status === 'complete'
        ? 'text-success'
        : status === 'error'
          ? 'text-destructive'
          : 'text-muted-foreground'

  return <span className={`text-xs font-medium ${color}`}>{sessionStatusLabel(status)}</span>
}

export default App
