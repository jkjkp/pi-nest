import { useEffect, useMemo, type ComponentProps } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { SessionNavigationRow } from './session-navigation-row.js'
import { buildSessionTree, filterSessionTree, flattenVisibleSessionTree, sessionAncestors } from './session-tree.js'
import { isRunActive } from './session-run-model.js'
import { sessionDisplayName, type PiSessionSummary } from './workspace.js'
import { useWorkspaceStore } from './workspace-store.js'

type Props = Omit<ComponentProps<typeof SessionNavigationRow>, 'session' | 'selected' | 'run' | 'branch' | 'sortParentId'> & {
  sessions: PiSessionSummary[]
  selectedSessionId: string
  runs: Record<string, NonNullable<ComponentProps<typeof SessionNavigationRow>['run']>>
  searchValue: string
  projectMatches: boolean
}

export function SessionTreeNavigation({ sessions, selectedSessionId, runs, searchValue, projectMatches, ...rowProps }: Props) {
  const collapsed = useWorkspaceStore((state) => state.collapsedSessionIds)
  const setCollapsed = useWorkspaceStore((state) => state.setSessionCollapsed)
  const expandAncestors = useWorkspaceStore((state) => state.expandSessionAncestors)
  const notifications = useWorkspaceStore((state) => state.sessionNotifications)
  const tree = useMemo(() => buildSessionTree(sessions), [sessions])
  useEffect(() => { expandAncestors(sessionAncestors(tree, selectedSessionId)) }, [tree, selectedSessionId, expandAncestors])
  const query = searchValue.trim().toLocaleLowerCase()
  const filtered = useMemo(() => !query || projectMatches ? tree : filterSessionTree(tree, (session) => sessionDisplayName(session).toLocaleLowerCase().includes(query)), [tree, query, projectMatches])
  const rows = useMemo(() => flattenVisibleSessionTree(filtered, collapsed, Boolean(query)), [filtered, collapsed, query])
  const summaries = useMemo(() => {
    const totals = new Map<string, { running: number; error: number; unread: number }>()
    const summaries = new Map<string, string>()
    const allRows = flattenVisibleSessionTree(tree, {}, true)
    for (let index = allRows.length - 1; index >= 0; index--) {
      const id = allRows[index].session.id
      const descendants = { running: 0, error: 0, unread: 0 }
      for (const child of tree.children.get(id) ?? []) {
        const total = totals.get(child)!
        descendants.running += total.running
        descendants.error += total.error
        descendants.unread += total.unread
      }
      summaries.set(id, [descendants.running && `${descendants.running} 运行中`, descendants.error && `${descendants.error} 失败`, descendants.unread && `${descendants.unread} 未读`].filter(Boolean).join(' · '))
      const notification = notifications[id]
      const status = runs[id]?.status ?? (notification?.pendingRunId ? 'running' : 'idle')
      totals.set(id, {
        running: descendants.running + Number(isRunActive(status)),
        error: descendants.error + Number(status === 'error'),
        unread: descendants.unread + Number(Boolean(notification?.completedRunId && notification.completedRunId !== notification.readRunId)),
      })
    }
    return summaries
  }, [tree, runs, notifications])

  // shortcut: Indentation stops at six levels to preserve title space; add horizontal navigation if deeper trees need it.
  return <SortableContext items={rows.map(({ session }) => `session:${session.id}`)} strategy={verticalListSortingStrategy}>
    {rows.map(({ session, depth, guides, last, hasChildren, expanded }) => <div key={session.id} className="relative" data-session-id={session.id} data-depth={depth} style={{ paddingLeft: (Math.min(depth, 6) + 1) * 12 }}>
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0">
        {guides.slice(-6).map((continues, index) => continues && <span key={index} className="absolute inset-y-0 border-l border-border/70" style={{ left: index * 12 + 6 }} />)}
        <span className={`absolute top-0 w-1.5 border-l border-border/70 ${last ? 'border-b' : ''}`} style={{ left: Math.min(depth, 6) * 12 + 6, height: last ? 18 : '100%' }} />
        {!last && <span className="absolute top-[18px] w-1.5 border-t border-border/70" style={{ left: Math.min(depth, 6) * 12 + 6 }} />}
      </span>
      <SessionNavigationRow {...rowProps} sortParentId={tree.parents.get(session.id)} session={session} selected={session.id === selectedSessionId} run={runs[session.id]} branch={{ hasChildren, expanded, onToggle: () => setCollapsed(session.id, expanded), summary: expanded ? '' : summaries.get(session.id) ?? '' }} />
    </div>)}
  </SortableContext>
}
