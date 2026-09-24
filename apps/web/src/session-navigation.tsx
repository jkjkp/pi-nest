import { useMemo, useState } from 'react'
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
import { ChevronRight, Ellipsis, Folder, FolderOpen, Pencil, Search, SquarePen, Trash2 } from 'lucide-react'

import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'

import type { SessionRunSummary } from './workspace-store.js'
import { filterProjectsByQuery, type PiSessionSummary, type ProjectSessionGroup, sessionDisplayName } from './workspace.js'

export function SessionNavigation({
  collapsedProjectKeys,
  error,
  isLoading,
  mutationSessionId,
  onDelete,
  onSelect,
  onRename,
  onProjectOrderChange,
  onNewConversation,
  onRemoveProject,
  onRestoreProject,
  onRevealProject,
  onSessionOrderChange,
  onToggleProject,
  projects,
  removedProjects,
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
  onNewConversation: (project: ProjectSessionGroup) => void
  onRemoveProject: (project: ProjectSessionGroup) => void
  onRestoreProject: (cwd: string) => void
  onRevealProject: (cwd: string) => Promise<void>
  onSessionOrderChange: (projectKey: string, sessionOrder: string[]) => void
  onToggleProject: (projectKey: string, collapsed: boolean) => void
  projects: ProjectSessionGroup[]
  removedProjects: ProjectSessionGroup[]
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
  const [removingProject, setRemovingProject] = useState<ProjectSessionGroup>()
  const [actionError, setActionError] = useState<string>()
  const [searchValue, setSearchValue] = useState('')
  const visibleProjects = useMemo(() => filterProjectsByQuery(projects, searchValue), [projects, searchValue])
  const isFiltering = searchValue.trim().length > 0

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
      <div className="border-b">
        <div className="flex h-14 items-center gap-2 px-4">
          <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">PN</span>
          <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight">Pi Nest</h2>
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
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {isLoading && Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-16" />)}
          {error && <p className="p-3 text-sm text-destructive">会话列表不可用</p>}
          {actionError && !renaming && !deleting && !removingProject && <p className="px-3 py-1 text-xs text-destructive" role="alert">{actionError}</p>}
          {!isLoading && !error && projects.length === 0 && <p className="p-3 text-sm text-muted-foreground">未发现本机 Pi 会话</p>}
          {!isLoading && !error && projects.length > 0 && visibleProjects.length === 0 && <p className="p-3 text-sm text-muted-foreground">未找到匹配的项目或会话</p>}
          <DndContext collisionDetection={closestCenter} onDragEnd={reorder} sensors={sensors}>
            <SortableContext items={visibleProjects.map((project) => `project:${project.key}`)} strategy={verticalListSortingStrategy}>
              {visibleProjects.map((project, index) => (
                <SortableProject
                  collapsed={collapsedProjectKeys[project.key] ?? !project.sessions.some((session) => session.id === selectedSessionId)}
                  disabled={isFiltering}
                  index={index}
                  key={project.key}
                  mutationSessionId={mutationSessionId}
                  onDelete={(session) => {
                    setActionError(undefined)
                    setDeleting(session)
                  }}
                  onNewConversation={onNewConversation}
                  onRemove={(project) => {
                    setActionError(undefined)
                    setRemovingProject(project)
                  }}
                  onReveal={async (cwd) => {
                    try {
                      await onRevealProject(cwd)
                    } catch {
                      setActionError('无法在 Finder 中显示项目，请确认目录仍可访问。')
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
          {removedProjects.length > 0 && !isFiltering && (
            <details className="mt-3 border-t pt-3">
              <summary className="cursor-pointer px-2 text-xs text-muted-foreground">已移除项目（{removedProjects.length}）</summary>
              <div className="mt-1 space-y-1">
                {removedProjects.map((project) => <Button className="h-8 w-full justify-between px-2 text-xs" key={project.key} onClick={() => project.cwd && onRestoreProject(project.cwd)} type="button" variant="ghost"><span className="truncate">{project.name}</span><span>恢复</span></Button>)}
              </div>
            </details>
          )}
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
      <AlertDialog onOpenChange={(open) => !open && setRemovingProject(undefined)} open={Boolean(removingProject)}>
        <AlertDialogContent>
          <AlertDialogTitle>从 Pi Nest 移除项目？</AlertDialogTitle>
          <AlertDialogDescription>仅从此浏览器的项目列表隐藏“{removingProject?.name}”。不会删除目录、Pi 原生会话或正在运行的任务，之后可在“已移除项目”中恢复。</AlertDialogDescription>
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
  collapsed,
  disabled,
  index,
  mutationSessionId,
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
  collapsed: boolean
  disabled: boolean
  index: number
  mutationSessionId: string | undefined
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
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({
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
    <section className="space-y-1" onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }} onFocusCapture={() => setFocused(true)} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} ref={setNodeRef} style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}>
      <div className="flex items-center rounded-md transition-colors hover:bg-muted">
      <button
        aria-controls={sessionListId}
        aria-expanded={expanded}
        aria-label={`项目 ${project.name}，目录 ${projectDescription}，${project.sessions.length} 个会话，${expanded ? '已展开' : '已折叠'}`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => onToggle(project.key, !collapsed)}
        ref={setActivatorNodeRef}
        title={project.cwd}
        type="button"
        {...attributes}
        {...listeners}
      >
        <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
        <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
      </button>
      <div className="flex w-[4.5rem] shrink-0 items-center justify-end gap-0.5 pr-1">
        <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
          <DropdownMenuTrigger asChild>
            <Button aria-label={`${project.name} 更多操作`} className={`size-7 transition-opacity motion-reduce:transition-none ${actionsClass}`} disabled={!project.cwd} onClick={stopProjectInteraction} onPointerDown={stopProjectInteraction} size="icon-sm" type="button" variant="ghost"><Ellipsis aria-hidden="true" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!project.cwd} onSelect={() => { if (project.cwd) void onReveal(project.cwd) }}><FolderOpen aria-hidden="true" className="mr-2 size-3.5" />在 Finder 中显示</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive" disabled={!project.cwd} onSelect={() => onRemove(project)}><Trash2 aria-hidden="true" className="mr-2 size-3.5" />移除项目</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button aria-label={`在 ${project.name} 新建对话`} className={`size-7 transition-opacity motion-reduce:transition-none ${actionsClass}`} disabled={!project.cwd} onClick={(event) => { stopProjectInteraction(event); onNewConversation(project) }} onPointerDown={stopProjectInteraction} size="icon-sm" type="button" variant="ghost"><SquarePen aria-hidden="true" /></Button>
      </div>
      </div>
      {expanded && (
        <div className="space-y-1 pl-2" id={sessionListId}>
          <SortableContext items={project.sessions.map((session) => `session:${session.id}`)} strategy={verticalListSortingStrategy}>
            {project.sessions.map((session) => (
              <SortableSession
                key={session.id}
                disabled={disabled}
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
  disabled,
  mutationSessionId,
  onDelete,
  onRename,
  onSelect,
  projectKey,
  run,
  selected,
  session,
}: {
  disabled: boolean
  mutationSessionId: string | undefined
  onDelete: (session: PiSessionSummary) => void
  onRename: (session: PiSessionSummary) => void
  onSelect: (sessionId: string) => void
  projectKey: string
  run: SessionRunSummary | undefined
  selected: boolean
  session: PiSessionSummary
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({
    data: { kind: 'session', projectKey },
    disabled,
    id: `session:${session.id}`,
  })
  const status = run?.status ?? 'idle'
  const cannotDelete = selected || status === 'running' || status === 'aborting' || mutationSessionId === session.id

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex items-center gap-1" ref={setNodeRef} style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}>
          <Button
            aria-current={selected ? 'page' : undefined}
            className={`h-9 min-w-0 flex-1 justify-start border-0 px-2 text-left ${selected ? 'bg-primary/10 hover:bg-primary/10' : 'bg-transparent hover:bg-muted/50'}`}
            onClick={() => onSelect(session.id)}
            ref={setActivatorNodeRef}
            variant="ghost"
            {...attributes}
            {...listeners}
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{sessionDisplayName(session)}</span>
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
