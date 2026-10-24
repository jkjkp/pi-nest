import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { ChevronRight, MessageSquare, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { NavigationTitle } from './navigation-title.js'
import { SessionStatusIndicator } from './session-status-indicator.js'
import { useWorkspaceStore } from './workspace-store.js'
import { isRunActive, type SessionRunSummary } from './session-run-model.js'
import { sessionDisplayName, type PiSessionSummary } from './workspace.js'

export function SessionNavigationRow({
  disabled,
  mutationSessionId,
  onDelete,
  onRename,
  onSelect,
  projectKey,
  run,
  selected,
  session,
  branch,
  sortParentId,
}: {
  sortParentId?: string
  branch?: { hasChildren: boolean; expanded: boolean; onToggle: () => void; summary: string }
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
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    data: { kind: 'session', projectKey, parentId: sortParentId },
    disabled,
    id: `session:${session.id}`,
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const notification = useWorkspaceStore((state) => state.sessionNotifications[session.id])
  const unread = Boolean(notification?.completedRunId && notification.completedRunId !== notification.readRunId)
  const status = run?.status ?? (notification?.pendingRunId ? 'running' : 'idle')
  const cannotDelete = isRunActive(status) || mutationSessionId === session.id

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <div className={`group/session flex items-center gap-1 rounded-lg ${selected ? 'bg-primary/10' : 'hover:bg-muted/50'}`} ref={setNodeRef} style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}>
          {branch && (branch.hasChildren ? <Button aria-label={`${branch.expanded ? '折叠' : '展开'} ${sessionDisplayName(session)} 的分支`} aria-expanded={branch.expanded} className="ml-1 size-6 shrink-0 border-0" size="icon-sm" variant="ghost" onClick={branch.onToggle} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><ChevronRight aria-hidden="true" className={`size-3.5 ${branch.expanded ? 'rotate-90' : ''}`} /></Button> : <span aria-hidden="true" className="ml-1 grid size-6 shrink-0 place-items-center text-muted-foreground"><MessageSquare className="size-3.5" /></span>)}
          <Button
            aria-current={selected ? 'page' : undefined}
            className="h-9 min-w-0 flex-1 justify-start border-0 bg-transparent px-2 text-left hover:bg-transparent"
            onClick={() => onSelect(session.id)}
            ref={setActivatorNodeRef}
            variant="ghost"
            {...attributes}
            {...listeners}
          >
            <NavigationTitle className="text-sm font-normal" stopped={isDragging || menuOpen}>{sessionDisplayName(session)}</NavigationTitle>
            {session.parentSessionMissing && <span title="来源会话不可用" aria-label="来源会话不可用" className="shrink-0 text-xs text-muted-foreground">↗</span>}
            <SessionStatusIndicator status={status} unread={unread} />
          </Button>
          {branch?.summary && <span role="status" title={branch.summary} className="max-w-[40%] shrink-0 truncate text-[10px] text-muted-foreground">{branch.summary}</span>}
          <Button aria-label={`删除 ${sessionDisplayName(session)}`} title={isRunActive(status) ? '运行中的会话无法删除' : '删除会话'} className="pointer-events-none mr-1 shrink-0 text-muted-foreground opacity-0 hover:text-destructive disabled:opacity-0 group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-hover/session:disabled:opacity-50 focus-visible:pointer-events-auto focus-visible:opacity-100" disabled={cannotDelete} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onDelete(session) }} size="icon-sm" type="button" variant="ghost"><Trash2 aria-hidden="true" className="size-3.5" /></Button>
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
