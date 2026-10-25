import { useMemo, useRef, useState } from 'react'
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
import { ChevronRight, Ellipsis, Folder, FolderOpen, List, ListTree, Plus, Search, SquarePen, Trash2 } from 'lucide-react'

import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { SessionRenameDialog } from './session-rename-dialog.js'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'

import { useWorkspaceStore } from './workspace-store.js'
import { SessionNavigationRow } from './session-navigation-row.js'
import { SessionTreeNavigation } from './session-tree-navigation.js'
import { buildSessionTree, reorderSessionSiblings } from './session-tree.js'
import { NavigationTitle } from './navigation-title.js'
import { isRunActive, type SessionRunSummary } from './session-run-model.js'
import { filterProjectsByQuery, type PiSessionSummary, type ProjectSessionGroup, sessionDisplayName } from './workspace.js'

export function SessionNavigation({
  collapsedProjectKeys,
  error,
  isLoading,
  mutationSessionId,
  onClone,
  onDelete,
  onSelect,
  onRename,
  onProjectOrderChange,
  onNewConversation,
  onAddProject,
  onRemoveProject,
  onRevealProject,
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
  onClone: (sessionId: string) => Promise<void>
  onDelete: (sessionId: string) => Promise<void>
  onSelect: (sessionId: string) => void
  onRename: (sessionId: string, name: string) => Promise<void>
  onProjectOrderChange: (projectOrder: string[]) => void
  onNewConversation: (project: ProjectSessionGroup) => void
  onAddProject: () => void
  onRemoveProject: (project: ProjectSessionGroup) => void
  onRevealProject: (cwd: string) => Promise<void>
  onSessionOrderChange: (projectKey: string, sessionOrder: string[]) => void
  onToggleProject: (projectKey: string, collapsed: boolean) => void
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
  const [deleting, setDeleting] = useState<PiSessionSummary>()
  const [deletePending, setDeletePending] = useState(false)
  const deleteInFlight = useRef(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const deleteTrigger = useRef<HTMLElement | null>(null)
  const deletingNotification = useWorkspaceStore((state) => deleting ? state.sessionNotifications[deleting.id] : undefined)
  const deleteBusy = deletePending || Boolean(deleting && mutationSessionId === deleting.id)
  const deleteBlocked = deleteBusy || isRunActive(runs[deleting?.id ?? '']?.status ?? (deletingNotification?.pendingRunId ? 'running' : 'idle'))
  const [removingProject, setRemovingProject] = useState<ProjectSessionGroup>()
  const [folderNotice, setFolderNotice] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const navigationView = useWorkspaceStore((state) => state.navigationView)
  const setNavigationView = useWorkspaceStore((state) => state.setNavigationView)
  const [searchValue, setSearchValue] = useState('')
  const visibleProjects = useMemo(() => {
    const filtered = filterProjectsByQuery(projects, searchValue)
    if (navigationView === 'list' || !searchValue.trim()) return filtered
    const keys = new Set(filtered.map((project) => project.key))
    return projects.filter((project) => keys.has(project.key))
  }, [projects, searchValue, navigationView])
  const isFiltering = searchValue.trim().length > 0

  function requestRename(session: PiSessionSummary) {
    setActionError(undefined)
    setRenaming(session)
  }

  async function confirmDelete() {
    if (!deleting || deleteBlocked || deleteInFlight.current) return
    deleteInFlight.current = true
    setDeletePending(true)
    setActionError(undefined)
    try {
      await onDelete(deleting.id)
      setDeleting(undefined)
    } catch {
      setActionError('删除失败，请刷新后重试。')
    } finally { deleteInFlight.current = false; setDeletePending(false) }
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
    if (navigationView === 'tree') {
      const order = reorderSessionSiblings(buildSessionTree(project.sessions), String(event.active.id).slice('session:'.length), String(over.id).slice('session:'.length))
      if (order) onSessionOrderChange(project.key, order)
      return
    }
    const activeIndex = project.sessions.findIndex((session) => `session:${session.id}` === event.active.id)
    const overIndex = project.sessions.findIndex((session) => `session:${session.id}` === over.id)
    if (activeIndex >= 0 && overIndex >= 0) {
      onSessionOrderChange(project.key, arrayMove(project.sessions.map((session) => session.id), activeIndex, overIndex))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b">
        <div className="flex h-14 items-center gap-2 px-4">
          <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-xs font-normal text-primary-foreground">PN</span>
          <h2 className="min-w-0 truncate text-sm font-normal tracking-tight">Pi Nest</h2>
        </div>
        <label className="relative block px-3 pb-3" htmlFor="session-search">
          <Search aria-hidden="true" className="pointer-events-none absolute left-5 top-2.5 size-3.5 text-muted-foreground" />
          <input
            className="h-8 w-full rounded-md border bg-background/60 py-1 pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            id="session-search"
            onChange={(event) => setSearchValue(event.target.value)}
            placeholder="搜索项目或会话"
            type="search"
            value={searchValue}
          />
        </label>
      </div>
      <div className="flex shrink-0 items-center justify-between px-4 pt-3 pb-1">
        <h3 className="text-xs font-normal text-muted-foreground">项目</h3>
        <div className="flex items-center gap-1">
        <div role="group" aria-label="会话显示方式" className="flex items-center rounded-md p-0.5">
          <Button aria-label="列表视图" title="列表视图" aria-pressed={navigationView === 'list'} size="icon-sm" className="size-6 border-0" variant={navigationView === 'list' ? 'secondary' : 'ghost'} onClick={() => setNavigationView('list')}><List aria-hidden="true" className="size-3.5" /></Button>
          <Button aria-label="树状视图" title="树状视图" aria-pressed={navigationView === 'tree'} size="icon-sm" className="size-6 border-0" variant={navigationView === 'tree' ? 'secondary' : 'ghost'} onClick={() => setNavigationView('tree')}><ListTree aria-hidden="true" className="size-3.5" /></Button>
        </div>
        <Button aria-label="创建项目" size="icon-sm" variant="ghost" onClick={onAddProject}><Plus aria-hidden="true" className="size-4" /></Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {isLoading && Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-16" />)}
          {error && <p className="p-3 text-sm text-destructive">会话列表不可用</p>}
          {actionError && !renaming && !deleting && !removingProject && <p className="px-3 py-1 text-xs text-destructive" role="alert">{actionError}</p>}
          {folderNotice && <p className="px-3 py-1 text-xs text-muted-foreground" role="status">{folderNotice}</p>}
          {!isLoading && !error && projects.length === 0 && <p className="p-3 text-sm text-muted-foreground">未发现本机 Pi 会话</p>}
          {!isLoading && !error && projects.length > 0 && visibleProjects.length === 0 && <p className="p-3 text-sm text-muted-foreground">未找到匹配的项目或会话</p>}
          <DndContext collisionDetection={(args) => closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((container) => {
            const active = args.active.data.current
            const target = container.data.current
            return active?.kind === target?.kind && (active?.kind === 'project' || active?.projectKey === target?.projectKey && (navigationView !== 'tree' || active?.parentId === target?.parentId))
          }) })} onDragEnd={reorder} sensors={sensors}>
            <SortableContext items={visibleProjects.map((project) => `project:${project.key}`)} strategy={verticalListSortingStrategy}>
              {visibleProjects.map((project, index) => (
                <SortableProject
                  collapsed={!isFiltering && (collapsedProjectKeys[project.key] ?? !project.sessions.some((session) => session.id === selectedSessionId))}
                  navigationView={navigationView}
                  searchValue={searchValue}
                  disabled={isFiltering}
                  index={index}
                  key={project.key}
                  mutationSessionId={mutationSessionId}
                  onClone={(session) => {
                    setActionError(undefined)
                    void onClone(session.id).catch((cause) => {
                      setActionError(cause instanceof Error ? cause.message : '克隆对话失败，请重试。')
                    })
                  }}
                  onDelete={(session) => {
                    deleteTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
                    setActionError(undefined)
                    setDeleting(session)
                  }}
                  onNewConversation={onNewConversation}
                  onRemove={(project) => {
                    setActionError(undefined)
                    setRemovingProject(project)
                  }}
                  onReveal={async (cwd) => {
                    setFolderNotice(undefined)
                    setActionError(undefined)
                    try {
                      await onRevealProject(cwd)
                      setFolderNotice('已请求系统打开项目文件夹')
                    } catch (cause) {
                      setActionError(cause instanceof Error ? cause.message : '无法打开项目文件夹，请确认目录存在且可访问。')
                    }
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
      {renaming && <SessionRenameDialog key={renaming.id} session={renaming} onClose={() => setRenaming(undefined)} onRename={onRename} />}
      <AlertDialog onOpenChange={(open) => { if (!open && !deleteInFlight.current) setDeleting(undefined) }} open={Boolean(deleting)}>
        <AlertDialogContent onOpenAutoFocus={(event) => { event.preventDefault(); deleteButton.current?.focus() }} onCloseAutoFocus={(event) => { event.preventDefault(); deleteTrigger.current?.focus() }}>
          <AlertDialogTitle>删除原生 Pi 会话？</AlertDialogTitle>
          <AlertDialogDescription>
            将删除“{deleting ? sessionDisplayName(deleting) : ''}”。优先移入系统废纸篓；若废纸篓不可用，会永久删除原生会话文件且无法恢复。
          </AlertDialogDescription>
          {actionError && <p className="mt-3 text-sm text-destructive" role="alert">{actionError}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogCancel asChild><Button disabled={deleteBusy} type="button" variant="secondary">取消</Button></AlertDialogCancel>
            <Button ref={deleteButton} disabled={deleteBlocked} onClick={() => void confirmDelete()} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat && !event.nativeEvent.isComposing) void confirmDelete() } }} type="button" variant="destructive">
              {deletePending ? '删除中…' : '删除会话'}
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog onOpenChange={(open) => !open && setRemovingProject(undefined)} open={Boolean(removingProject)}>
        <AlertDialogContent>
          <AlertDialogTitle>从 Pi Nest 移除项目？</AlertDialogTitle>
          <AlertDialogDescription>仅从此浏览器的项目列表隐藏“{removingProject?.name}”。不会删除目录、Pi 原生会话或正在运行的任务，之后可在“设置 → 项目管理”中恢复。</AlertDialogDescription>
          {actionError && <p className="mt-3 text-sm text-destructive" role="alert">{actionError}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogCancel asChild><Button type="button" variant="secondary">取消</Button></AlertDialogCancel>
            <Button onClick={() => { if (removingProject) onRemoveProject(removingProject); setRemovingProject(undefined) }} type="button" variant="destructive">移除项目</Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SortableProject({
  navigationView,
  searchValue,
  collapsed,
  disabled,
  index,
  mutationSessionId,
  onClone,
  onDelete,
  onNewConversation,
  onRemove,
  onReveal,
  onRename,
  onSelect,
  onToggle,
  project,
  runs,
  selectedSessionId,
}: {
  navigationView: 'list' | 'tree'
  searchValue: string
  collapsed: boolean
  disabled: boolean
  index: number
  mutationSessionId: string | undefined
  onClone: (session: PiSessionSummary) => void
  onDelete: (session: PiSessionSummary) => void
  onNewConversation: (project: ProjectSessionGroup) => void
  onRemove: (project: ProjectSessionGroup) => void
  onReveal: (cwd: string) => Promise<void>
  onRename: (session: PiSessionSummary) => void
  onSelect: (sessionId: string) => void
  onToggle: (projectKey: string, collapsed: boolean) => void
  project: ProjectSessionGroup
  runs: Record<string, SessionRunSummary>
  selectedSessionId: string
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    data: { kind: 'project', projectKey: project.key },
    disabled,
    id: `project:${project.key}`,
  })
  const expanded = !collapsed
  const sessionListId = `project-sessions-${index}`
  const projectDescription = project.cwd ?? '工作目录不可用'
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const actionsVisible = hovered || focused || menuOpen
  const actionsClass = actionsVisible ? 'opacity-100' : 'pointer-events-none opacity-0 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100'
  const stopProjectInteraction = (event: React.SyntheticEvent) => event.stopPropagation()

  return (
    <section className="space-y-1" ref={setNodeRef} style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}>
      <div className="flex items-center rounded-md transition-colors hover:bg-muted" onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }} onFocusCapture={() => setFocused(true)} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      <button
        aria-controls={sessionListId}
        aria-expanded={expanded}
        aria-label={`项目 ${project.name}，目录 ${projectDescription}，${project.sessions.length} 个会话，${expanded ? '已展开' : '已折叠'}`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-normal outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => onToggle(project.key, !collapsed)}
        ref={setActivatorNodeRef}
        title={project.cwd}
        type="button"
        {...attributes}
        {...listeners}
      >
        <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
        <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <NavigationTitle stopped={isDragging || menuOpen}>{project.name}</NavigationTitle>
      </button>
      <div className="flex w-[4.5rem] shrink-0 items-center justify-end gap-0.5 pr-1">
        <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
          <DropdownMenuTrigger asChild>
            <Button aria-label={`${project.name} 更多操作`} className={`size-7 border-0 transition-opacity motion-reduce:transition-none ${actionsClass}`} disabled={!project.cwd} onClick={stopProjectInteraction} onPointerDown={stopProjectInteraction} size="icon-sm" type="button" variant="ghost"><Ellipsis aria-hidden="true" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!project.cwd} onSelect={() => { if (project.cwd) void onReveal(project.cwd) }}><FolderOpen aria-hidden="true" className="mr-2 size-3.5" />打开项目文件夹</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive" disabled={!project.cwd} onSelect={() => onRemove(project)}><Trash2 aria-hidden="true" className="mr-2 size-3.5" />移除项目</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button aria-label={`在 ${project.name} 新建对话`} className={`size-7 border-0 transition-opacity motion-reduce:transition-none ${actionsClass}`} disabled={!project.cwd} onClick={(event) => { stopProjectInteraction(event); onNewConversation(project) }} onPointerDown={stopProjectInteraction} size="icon-sm" type="button" variant="ghost"><SquarePen aria-hidden="true" /></Button>
      </div>
      </div>
      {expanded && (
        <div className="space-y-1 pl-2" id={sessionListId}>
          {navigationView === 'tree' ? <SessionTreeNavigation sessions={project.sessions} projectKey={project.key} searchValue={searchValue} projectMatches={Boolean(searchValue.trim()) && `${project.name} ${project.cwd ?? ''}`.toLocaleLowerCase().includes(searchValue.trim().toLocaleLowerCase())} disabled={disabled} mutationSessionId={mutationSessionId} onClone={onClone} onDelete={onDelete} onRename={onRename} onSelect={onSelect} runs={runs} selectedSessionId={selectedSessionId} /> : <SortableContext items={project.sessions.map((session) => `session:${session.id}`)} strategy={verticalListSortingStrategy}>
            {project.sessions.map((session) => (
              <SessionNavigationRow
                key={session.id}
                disabled={disabled}
                mutationSessionId={mutationSessionId}
                onClone={onClone}
                onDelete={onDelete}
                onRename={onRename}
                onSelect={onSelect}
                projectKey={project.key}
                run={runs[session.id]}
                selected={session.id === selectedSessionId}
                session={session}
              />
            ))}
          </SortableContext>}
        </div>
      )}
    </section>
  )
}
