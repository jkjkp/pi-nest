import { useShallow } from 'zustand/react/shallow'
import { sessionDisplayName, sessionStatusLabel } from './workspace.js'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PiSessionBranchRequest } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { fetchSessionGraph } from './workspace-api.js'
import { graphAncestors, layoutGraph, type GraphNode } from './session-graph-model.js'
import { SessionGraphCanvas } from './session-graph-canvas.js'
import { SessionGraphPreview, type GraphSelection } from './session-graph-preview.js'
import { useWorkspaceStore } from './workspace-store.js'

export function SessionGraphWorkspace({ enabled, sessionId, selection, onPreview, onSelect, onBranch, children }: {
  enabled: boolean; sessionId: string; selection?: GraphSelection; onPreview: (selection?: GraphSelection) => void
  onSelect: (sessionId: string) => void; onBranch: (sessionId: string, request: PiSessionBranchRequest) => Promise<void>; children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  const [folds, setFolds] = useState<{ owner: string; collapsed: Record<string, boolean> }>({ owner: sessionId, collapsed: {} })
  const [locateRequest, setLocateRequest] = useState(0)
  const [showDetails, setShowDetails] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const intent = useRef({ sessionId, selection })
  useLayoutEffect(() => { intent.current = { sessionId, selection } }, [sessionId, selection])
  const statuses = useWorkspaceStore(useShallow((state) => Object.fromEntries(Object.keys({ ...state.sessionNotifications, ...state.runs }).map((id) => [id, state.runs[id]?.status ?? (state.sessionNotifications[id]?.pendingRunId ? 'running' : 'idle')]))))
  const pendingOperation = useWorkspaceStore((state) => selection ? state.branchOperations[selection.sessionId] : undefined)
  const graph = useQuery({ queryKey: ['session-graph', sessionId], enabled: enabled && Boolean(sessionId), queryFn: ({ signal }) => fetchSessionGraph(sessionId, signal), retry: false })
  const sessions = graph.data?.sessions
  const nodes = useMemo(() => {
    return layoutGraph(sessions ?? [], folds.owner === sessionId ? folds.collapsed : {}).map((node) => statuses[node.id] ? { ...node, status: sessionStatusLabel(statuses[node.id]) } : node)
  }, [sessions, folds, sessionId, statuses])
  useEffect(() => {
    if (!root.current) return
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 960))
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  function choose(node: GraphNode) { setError(undefined); onPreview({ sessionId: node.id }); setShowDetails(true) }
  function revealCurrent() {
    setFolds((value) => ({ owner: sessionId, collapsed: { ...(value.owner === sessionId ? value.collapsed : {}), ...Object.fromEntries(graphAncestors(sessions ?? [], sessionId).map((id) => [id, false])) } }))
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
    {enabled && <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1 text-xs">
      <span className="mr-auto text-muted-foreground">独立会话分支 · 每个节点一个会话</span>
      {!wide && <Button size="sm" variant="ghost" onClick={() => setShowDetails((value) => !value)}>{showDetails ? '返回画布' : '查看对话'}</Button>}
      <Button size="sm" variant="ghost" onClick={() => void graph.refetch()}>刷新树</Button>
    </div>}
    {enabled && (error || graph.isError) && <p role="alert" className="px-3 py-1 text-xs text-destructive">{error || '关联会话读取失败，请重试。'}</p>}
    {enabled && graph.data?.branchStorage.available === false && <p role="alert" className="px-3 text-xs text-destructive">关系存储不可用；普通对话可用，新建分支已禁用。</p>}
    <div className="relative grid min-h-0 flex-1" style={{ gridTemplateColumns: enabled && wide ? 'minmax(0,45fr) minmax(0,55fr)' : 'minmax(0,1fr)' }}>
      <section aria-label="树状画布区域" className={`${!enabled || !wide && showDetails ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-col border-r`}>
        {graph.isPending && <p role="status" className="p-2 text-xs">正在读取关联会话…</p>}
        <SessionGraphCanvas nodes={nodes} selectedSessionId={sessionId} selectedNodeId={selection?.sessionId} onSelect={choose}
          locateRequest={locateRequest} onLocate={revealCurrent} onToggle={(id) => setFolds((value) => {
            const collapsed = value.owner === sessionId ? value.collapsed : {}
            return { owner: sessionId, collapsed: { ...collapsed, [id]: !collapsed[id] } }
          })} />
      </section>
      <section aria-label={selection ? '节点只读预览' : '当前会话对话'} aria-hidden={enabled && !wide && !showDetails} inert={enabled && !wide && !showDetails} className={`${enabled && !wide && !showDetails ? 'invisible pointer-events-none absolute inset-0' : 'relative'} flex min-h-0 min-w-0 flex-col`}>
        {selection && <>
          <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs">
            <span className="min-w-0 basis-full sm:basis-auto sm:flex-1"><span className="block break-all">正在预览 · {source ? sessionDisplayName(source) : selection.sessionId}</span><span className="block break-all text-muted-foreground">发送目标 · {current ? sessionDisplayName(current) : sessionId}</span></span>
            <Button size="sm" variant="ghost" onClick={() => onPreview(undefined)}>返回当前会话</Button>
            <Button size="sm" variant="outline" onClick={() => { onSelect(selection.sessionId); onPreview(undefined) }}>切换到此会话继续</Button>
          </div>
          {pendingOperation && <p role="status" className="p-2 text-xs">此会话分支创建结果待确认；请切换到此会话后查询结果，勿重复创建。</p>}
          <SessionGraphPreview key={selection.sessionId} selection={selection} cwd={source?.cwd} onBranch={branch} branchDisabled={saving || Boolean(pendingOperation) || !graph.data?.branchStorage.available} />
        </>}
        <div aria-hidden={Boolean(selection)} inert={Boolean(selection)} className={`${selection ? 'invisible pointer-events-none absolute inset-0' : 'relative'} flex min-h-0 flex-1 flex-col`}>{children}</div>
      </section>
    </div>
  </div>
}
