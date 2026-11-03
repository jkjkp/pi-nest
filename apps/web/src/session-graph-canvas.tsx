import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { fitDiagramCamera, panDiagramCamera, zoomDiagramCamera, type DiagramCamera } from './diagram-camera.js'
import type { GraphNode } from './session-graph-model.js'

export function SessionGraphCanvas({ nodes, selectedSessionId, selectedNodeId, onSelect, onToggle, onLocate, locateRequest, renderNodeMenu, toolbarActions }: { toolbarActions?: ReactNode; renderNodeMenu: (node: GraphNode) => ReactNode; onToggle: (id: string) => void; onLocate: () => void; locateRequest: number; nodes: GraphNode[]; selectedSessionId: string; selectedNodeId?: string; onSelect: (node: GraphNode) => void }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [camera, setCamera] = useState<DiagramCamera>({ scale: 1, x: 0, y: 0, width: 800, height: 600, fit: false })
  const drag = useRef<{ x: number; y: number } | undefined>(undefined)
  useEffect(() => {
    if (!viewport.current) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) setCamera((value) => ({ ...value, width: entry.contentRect.width, height: entry.contentRect.height }))
    })
    observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [])
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const visible = nodes.filter((node) => {
    const x = node.x * camera.scale + camera.x; const y = node.y * camera.scale + camera.y
    return x + 260 * camera.scale >= -128 && x <= camera.width + 128 && y + 132 * camera.scale >= -128 && y <= camera.height + 128
  })
  const visibleIds = new Set(visible.map((node) => node.id))
  function measured() { const rect = viewport.current?.getBoundingClientRect(); return { ...camera, width: rect?.width || camera.width, height: rect?.height || camera.height } }
  const previousLayout = useRef<{ byId: Map<string, GraphNode>; current: string; locateRequest: number } | undefined>(undefined)
  useLayoutEffect(() => {
    const node = byId.get(selectedSessionId)
    if (!node) return
    const previous = previousLayout.current
    previousLayout.current = { byId, current: selectedSessionId, locateRequest }
    setCamera((value) => {
      const rect = viewport.current?.getBoundingClientRect()
      const width = rect?.width || value.width; const height = rect?.height || value.height
      const anchor = previous?.byId.get(previous.current)
      const shared = anchor && byId.has(anchor.id) ? anchor : [...(previous?.byId.values() ?? [])].find((item) => byId.has(item.id))
      let x = value.x; let y = value.y
      if (shared) {
        const next = byId.get(shared.id)!
        x += (shared.x - next.x) * value.scale; y += (shared.y - next.y) * value.scale
      }
      if (!shared || previous?.locateRequest !== locateRequest) {
        x = 24 - node.x * value.scale; y = 48 - node.y * value.scale
      } else if (previous.current !== selectedSessionId) {
        const left = node.x * value.scale + x; const top = node.y * value.scale + y
        x += left < 24 ? 24 - left : Math.min(0, width - 24 - left - 260 * value.scale)
        y += top < 48 ? 48 - top : Math.min(0, height - 24 - top - 132 * value.scale)
      }
      return x === value.x && y === value.y && width === value.width && height === value.height ? value : { ...value, x, y, width, height }
    })
  }, [locateRequest, byId, selectedSessionId])
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-1 border-b p-2">
      <Button size="sm" variant="ghost" aria-label="缩小树状画布" onClick={() => setCamera(zoomDiagramCamera(measured(), Math.max(0.25, camera.scale / 1.2)))}>−</Button>
      <span className="text-xs tabular-nums">{Math.round(camera.scale * 100)}%</span>
      <Button size="sm" variant="ghost" aria-label="放大树状画布" onClick={() => setCamera(zoomDiagramCamera(measured(), Math.min(2, Math.max(0.25, camera.scale * 1.2))))}>+</Button>
      <Button size="sm" variant="ghost" onClick={() => { const next = measured(); setCamera(fitDiagramCamera({ width: Math.max(480, ...nodes.map((node) => node.x + 284)), height: Math.max(300, ...nodes.map((node) => node.y + 156)) }, next)) }}>适应画布</Button>
      <Button size="sm" variant="ghost" onClick={onLocate}>定位当前</Button>
      {toolbarActions}
    </div>
    <div ref={(element) => { viewport.current = element }} tabIndex={0} aria-label="会话分支画布，方向键平移，点击节点查看会话" className="relative min-h-0 flex-1 touch-none overflow-clip bg-muted/20 outline-offset-[-2px]"
      onFocus={() => { const next = measured(); if (next.width !== camera.width || next.height !== camera.height) setCamera(next) }}
      onKeyDown={(event) => { if (event.target !== event.currentTarget) return; const move = ({ ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] } as Record<string, number[]>)[event.key]; if (move) { event.preventDefault(); setCamera(panDiagramCamera(measured(), move[0], move[1])) } }}
      onPointerDown={(event) => { if (event.button !== 0 || !event.currentTarget.contains(event.target as Node) || (event.target as Element).closest('button')) return; drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={(event) => { if (!drag.current) return; const delta = { x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }; drag.current = { x: event.clientX, y: event.clientY }; setCamera((current) => panDiagramCamera({ ...current, width: viewport.current?.clientWidth || current.width, height: viewport.current?.clientHeight || current.height }, delta.x, delta.y)) }}
      onPointerUp={() => { drag.current = undefined }} onPointerCancel={() => { drag.current = undefined }}>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full text-muted-foreground/50">
        <g transform={`translate(${camera.x},${camera.y}) scale(${camera.scale})`}>
          {nodes.filter((node) => node.parent && (visibleIds.has(node.id) || visibleIds.has(node.parent))).map((node) => { const parent = byId.get(node.parent!); return parent && <path key={node.id} d={`M ${parent.x + 260} ${parent.y + 66} C ${parent.x + 290} ${parent.y + 66}, ${node.x - 24} ${node.y + 66}, ${node.x} ${node.y + 66}`} fill="none" stroke="currentColor" strokeWidth="1.5" /> })}
        </g>
      </svg>
      <div className="absolute origin-top-left" style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})` }}>
        {visible.map((node) => {
          const state = node.id === selectedSessionId ? 'current' : node.id === selectedNodeId ? 'preview' : 'idle'
          return <ContextMenu key={node.id}><ContextMenuTrigger asChild><div onContextMenu={(event) => { event.stopPropagation(); event.currentTarget.querySelector('button')?.focus() }}
            onKeyDown={(event) => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }))
            }} data-session-node={node.id} className="absolute h-[132px] w-[260px] select-none" style={{ left: node.x, top: node.y }}>
          <button type="button" data-node-state={state} aria-current={state === 'current' ? 'true' : undefined} aria-pressed={state === 'preview'} title={node.label}
            className="session-graph-node flex size-full flex-col gap-1 rounded-lg border-2 bg-card p-3 text-left text-xs shadow-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
            onClick={() => onSelect(node)}>
            <span className="flex h-[18px] w-full min-w-0 items-center gap-2 pr-6">
              <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] leading-[14px] ${state === 'current' ? 'bg-ring/15 text-foreground' : state === 'preview' ? 'bg-warning/15 text-foreground' : 'text-muted-foreground'}`}>
                {state === 'preview' && <Eye aria-hidden="true" className="size-3" />}
                {state === 'current' ? '当前会话' : state === 'preview' ? '只读预览' : '独立会话'}
              </span>
              {node.status && <span className="truncate text-muted-foreground">{node.status}</span>}
            </span>
            <span className="w-full truncate font-medium">{node.label}</span>
            <span className="line-clamp-2 break-all text-muted-foreground">{node.summary}</span>
            {(node.notice || node.connectionLabel) && <span className={`mt-auto w-full truncate ${node.notice ? 'text-destructive' : 'text-muted-foreground'}`} title={[node.notice, node.connectionLabel, node.sourceEntryId && `来源节点 ${node.sourceEntryId}`].filter(Boolean).join(' · ')}>{node.notice || node.connectionLabel}</span>}
          </button>
          {node.hasChildren && <Button size="icon-sm" variant="ghost" className="absolute right-1 top-1" aria-label={`${node.collapsed ? '展开' : '折叠'} ${node.label} 的子会话`} aria-expanded={!node.collapsed} onClick={() => onToggle(node.id)}>{node.collapsed ? '+' : '−'}</Button>}
        </div></ContextMenuTrigger>{renderNodeMenu(node)}</ContextMenu>})}
      </div>
    </div>
  </div>
}
