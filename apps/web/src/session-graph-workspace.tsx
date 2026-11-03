import { useShallow } from 'zustand/react/shallow'
import { sessionDisplayName, sessionStatusLabel } from './workspace.js'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PiSessionBranchRequest, PiSessionGraph, PiSessionSummary } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { ArrowRight, Copy, Pencil, Trash2 } from 'lucide-react'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { SessionRenameDialog } from './session-rename-dialog.js'
import { SessionDeleteDialog } from './session-delete-dialog.js'
import { isRunActive } from './session-run-model.js'
import { fetchSessionGraph } from './workspace-api.js'
import { clampGraphSplitRatio, graphAncestors, layoutGraph, type GraphNode } from './session-graph-model.js'
import { SessionGraphCanvas } from './session-graph-canvas.js'
import { SessionGraphPreview, type GraphSelection } from './session-graph-preview.js'
import { useWorkspaceStore } from './workspace-store.js'
import { useSessionRead } from './use-session-read.js'
import { SessionGraphSplitter } from './session-graph-splitter.js'

export function SessionGraphWorkspace({ enabled, sessionId, selection, onPreview, onCurrentNodeClick, onSelect, onBranch, onRename, onClone, onDelete, onRead, currentReadReady, readBlocked = false, mutationSessionId, children }: {
  mutationSessionId?: string; onRename: (id: string, name: string) => Promise<void>; onClone: (id: string) => Promise<void>; onDelete: (id: string) => Promise<void>
  enabled: boolean; sessionId: string; selection?: GraphSelection; onPreview: (selection?: GraphSelection) => void
  onCurrentNodeClick: () => void; onSelect: (sessionId: string) => void; onBranch: (sessionId: string, request: PiSessionBranchRequest) => Promise<void>; children: ReactNode
  onRead: (sessionId: string, runId: string) => void; currentReadReady: boolean; readBlocked?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const wide = width >= 960
  const savedRatio = useWorkspaceStore((state) => state.graphSplitRatio)
  const setSavedRatio = useWorkspaceStore((state) => state.setGraphSplitRatio)
  const [dragRatio, setDragRatio] = useState<number>()
  const ratio = clampGraphSplitRatio(dragRatio ?? savedRatio, width)
  if (dragRatio !== undefined && (!enabled || !wide)) setDragRatio(undefined)
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const [locateRequest, setLocateRequest] = useState(0)
  const [showDetails, setShowDetails] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dialog, setDialog] = useState<{ kind: 'rename' | 'delete'; session: PiSessionSummary }>()
  const deletedSessionId = useRef<string | undefined>(undefined)
  const deletingRun = useWorkspaceStore((state) => dialog?.kind === 'delete' ? state.runs[dialog.session.id] : undefined)
  const branchOperations = useWorkspaceStore((state) => state.branchOperations)
  const [error, setError] = useState<string>()
  const intent = useRef({ sessionId, selection })
  useLayoutEffect(() => { intent.current = { sessionId, selection } }, [sessionId, selection])
  const notifications = useWorkspaceStore((state) => state.sessionNotifications)
  const statuses = useWorkspaceStore(useShallow((state) => Object.fromEntries(Object.keys({ ...state.sessionNotifications, ...state.runs }).map((id) => {
    const status = state.runs[id]?.status ?? 'idle'
    return [id, !isRunActive(status) && state.sessionNotifications[id]?.pendingRunId ? 'running' : status]
  }))))
  useSessionRead(sessionId, currentReadReady && !readBlocked && !selection && (!enabled || wide || showDetails), onRead)
  const pendingOperation = useWorkspaceStore((state) => selection ? state.branchOperations[selection.sessionId] : undefined)
  const queryClient = useQueryClient()
  const graph = useQuery({ queryKey: ['session-graph', sessionId], enabled: enabled && Boolean(sessionId), queryFn: ({ signal }) => fetchSessionGraph(sessionId, signal), retry: false,
    initialData: () => queryClient.getQueriesData<PiSessionGraph>({ queryKey: ['session-graph'] }).find(([, data]) => data?.sessions.some((session) => session.id === sessionId))?.[1],
  })
  const sessions = graph.data?.sessions
  const revealedSession = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (revealedSession.current === sessionId || !sessions?.some((session) => session.id === sessionId)) return
    revealedSession.current = sessionId
    setFolds((value) => graphAncestors(sessions, sessionId).some((id) => value[id]) ? { ...value, ...Object.fromEntries(graphAncestors(sessions, sessionId).map((id) => [id, false])) } : value)
  }, [sessionId, sessions])
  const nodes = useMemo(() => {
    return layoutGraph(sessions ?? [], folds).map((node) => {
      const notification = notifications[node.id]
      const status = statuses[node.id]
      const unread = Boolean(notification?.completedRunId && notification.completedRunId !== notification.readRunId)
      const completed = status === 'complete' || (!status || status === 'idle') && Boolean(notification?.completedRunId)
      const label = completed ? unread ? sessionStatusLabel('complete') : undefined : status ? sessionStatusLabel(status) : undefined
      return { ...node, status: node.id === mutationSessionId ? '更新中…' : label }
    })
  }, [sessions, folds, statuses, notifications, mutationSessionId])
  useEffect(() => {
    if (!root.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (graph.isSuccess && !graph.isFetching && selection && !sessions?.some((session) => session.id === selection.sessionId)) onPreview(undefined)
  }, [graph.isSuccess, graph.isFetching, sessions, selection, onPreview])
  function switchTo(id: string) {
    setError(undefined)
    if (id === sessionId) onCurrentNodeClick()
    else { onSelect(id); onPreview(undefined) }
    setShowDetails(true)
  }
  function restoreNodeFocus(event: Event, id: string) {
    event.preventDefault()
    const target = deletedSessionId.current === id ? undefined : root.current?.querySelector<HTMLButtonElement>(`[data-session-node="${CSS.escape(id)}"] > button`)
    const canvas = root.current?.querySelector<HTMLElement>('[aria-label="会话分支画布，方向键平移，点击节点查看会话"]')
    const next = target ?? canvas
    next?.focus()
  }
  async function clone(id: string) {
    if (saving) return
    const original = intent.current
    setSaving(true); setError(undefined)
    try {
      await onClone(id)
      if (intent.current === original) setShowDetails(true)
    } catch (cause) {
      if (intent.current === original) setError(cause instanceof Error ? cause.message : '克隆对话失败，请重试。')
    } finally { setSaving(false) }
  }
  function nodeMenu(node: GraphNode) {
    const target = sessions?.find((session) => session.id === node.id)
    const busy = isRunActive(statuses[node.id]) || mutationSessionId !== undefined || saving
    return <ContextMenuContent>
      <ContextMenuItem onSelect={() => switchTo(node.id)}><ArrowRight aria-hidden="true" className="mr-2 size-3" />切换到此处</ContextMenuItem>
      <ContextMenuItem disabled={!target || busy} onSelect={() => target && setDialog({ kind: 'rename', session: target })}><Pencil aria-hidden="true" className="mr-2 size-3" />重命名</ContextMenuItem>
      <ContextMenuItem disabled={!target || busy || Boolean(branchOperations[node.id]) || !graph.data?.branchStorage.available} onSelect={() => void clone(node.id)}><Copy aria-hidden="true" className="mr-2 size-3" />克隆对话</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive" disabled={!target || busy} onSelect={() => target && setDialog({ kind: 'delete', session: target })}><Trash2 aria-hidden="true" className="mr-2 size-3" />删除</ContextMenuItem>
    </ContextMenuContent>
  }
  function choose(node: GraphNode) {
    setError(undefined)
    if (node.id === sessionId) onCurrentNodeClick()
    else onPreview({ sessionId: node.id })
    setShowDetails(true)
  }
  function revealCurrent() {
    setFolds((value) => ({ ...value, ...Object.fromEntries(graphAncestors(sessions ?? [], sessionId).map((id) => [id, false])) }))
    setLocateRequest((value) => value + 1)
  }
  async function branch(request: PiSessionBranchRequest) {
    if (!selection || saving) return
    const original = intent.current
    setSaving(true); setError(undefined)
    try {
      await onBranch(selection.sessionId, request)
      if (intent.current.sessionId === original.sessionId && intent.current.selection === original.selection) onPreview(undefined)
    } catch (cause) {
      if (intent.current.sessionId === original.sessionId && intent.current.selection === original.selection) setError(cause instanceof Error ? cause.message : '创建分支失败')
      throw cause
    } finally { setSaving(false) }
  }
  const source = sessions?.find((session) => session.id === selection?.sessionId)
  const current = sessions?.find((session) => session.id === sessionId)
  return <div ref={root} className="flex min-h-0 flex-1 flex-col">
    {dialog?.kind === 'rename' && <SessionRenameDialog key={dialog.session.id} session={dialog.session} onRename={onRename} onClose={() => setDialog(undefined)} onCloseAutoFocus={(event) => restoreNodeFocus(event, dialog.session.id)} />}
    {dialog?.kind === 'delete' && <SessionDeleteDialog key={dialog.session.id} session={dialog.session} run={deletingRun} mutationSessionId={mutationSessionId} onDelete={async (id) => {
      await onDelete(id)
      deletedSessionId.current = id
      if (intent.current.selection?.sessionId === id) onPreview(undefined)
    }} onClose={() => setDialog(undefined)} onCloseAutoFocus={(event) => restoreNodeFocus(event, dialog.session.id)} />}
    {enabled && (error || graph.isError) && <div role="alert" className="flex items-center gap-2 px-3 py-1 text-xs text-destructive"><span>{error || '关联会话读取失败，请重试。'}</span>{graph.isError && <Button size="sm" variant="ghost" onClick={() => void graph.refetch()}>重试</Button>}</div>}
    {enabled && graph.data?.branchStorage.available === false && <p role="alert" className="px-3 text-xs text-destructive">关系存储不可用；普通对话可用，新建分支已禁用。</p>}
    <div data-resizing={dragRatio !== undefined} className="relative grid min-h-0 flex-1" style={{ gridTemplateColumns: enabled && wide ? `minmax(0,${ratio}fr) minmax(0,${1 - ratio}fr)` : 'minmax(0,1fr)' }}>
      <section id="session-graph-panel" aria-label="树状画布区域" className={`${!enabled || !wide && showDetails ? 'hidden' : 'flex'} relative min-h-0 min-w-0 flex-col border-r`}>
        {graph.isPending && <p role="status" className="p-2 text-xs">正在读取关联会话…</p>}
        <SessionGraphCanvas renderNodeMenu={nodeMenu} nodes={nodes} selectedSessionId={sessionId} selectedNodeId={selection?.sessionId} onSelect={choose}
          toolbarActions={enabled && !wide && <Button size="sm" variant="ghost" onClick={() => setShowDetails(true)}>查看对话</Button>}
          locateRequest={locateRequest} onLocate={revealCurrent} onToggle={(id) => setFolds((value) => ({ ...value, [id]: !value[id] }))} />
        {enabled && wide && <SessionGraphSplitter containerRef={root} width={width} ratio={ratio} onChange={setDragRatio} onCommit={(next) => { setSavedRatio(next); setDragRatio(undefined) }} />}
      </section>
      <section aria-label={selection ? '节点只读预览' : '当前会话对话'} aria-hidden={enabled && !wide && !showDetails} inert={enabled && !wide && !showDetails} className={`${enabled && !wide && !showDetails ? 'invisible pointer-events-none absolute inset-0' : 'relative'} flex min-h-0 min-w-0 flex-col`}>
        {enabled && !wide && showDetails && <div className="border-b p-2"><Button size="sm" variant="ghost" onClick={() => setShowDetails(false)}>返回画布</Button></div>}
        {selection && <>
          <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs">
            <span className="min-w-0 basis-full sm:basis-auto sm:flex-1"><span className="block break-all">正在预览 · {source ? sessionDisplayName(source) : selection.sessionId}</span><span className="block break-all text-muted-foreground">发送目标 · {current ? sessionDisplayName(current) : sessionId}</span></span>
            <Button size="sm" variant="ghost" onClick={() => onPreview(undefined)}>返回当前会话</Button>
            <Button size="sm" variant="outline" onClick={() => switchTo(selection.sessionId)}>切换到此会话继续</Button>
          </div>
          {pendingOperation && !saving && mutationSessionId !== selection.sessionId && <p role="status" className="p-2 text-xs">此会话分支创建结果待确认；请切换到此会话后查询结果，勿重复创建。</p>}
          <SessionGraphPreview key={selection.sessionId} selection={selection} cwd={source?.cwd} onBranch={branch} branchDisabled={saving || Boolean(pendingOperation) || !graph.data?.branchStorage.available} visible={!readBlocked && enabled && (wide || showDetails)} onRead={onRead} />
        </>}
        <div aria-hidden={Boolean(selection)} inert={Boolean(selection)} className={`${selection ? 'invisible pointer-events-none absolute inset-0' : 'relative'} flex min-h-0 flex-1 flex-col`}>{children}</div>
      </section>
    </div>
  </div>
}
