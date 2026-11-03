import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { fitDiagramCamera, panDiagramCamera, zoomDiagramCamera, type DiagramCamera } from './diagram-camera.js'
import type { GraphNode } from './session-graph-model.js'

export function SessionGraphCanvas({ nodes, selectedSessionId, selectedNodeId, onSelect, onToggle, onLocate, locateRequest }: { onToggle: (id: string) => void; onLocate: () => void; locateRequest: number; nodes: GraphNode[]; selectedSessionId: string; selectedNodeId?: string; onSelect: (node: GraphNode) => void }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [camera, setCamera] = useState<DiagramCamera>({ scale: 1, x: 0, y: 0, width: 800, height: 600, fit: false })
  const drag = useRef<{ x: number; y: number } | undefined>(undefined)
  useEffect(() => {
    if (!viewport.current) return
    const observer = new ResizeObserver(([entry]) => setCamera((value) => ({ ...value, width: entry.contentRect.width, height: entry.contentRect.height })))
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
  const lastLocate = useRef<string | undefined>(undefined)
  useEffect(() => {
    const key = JSON.stringify([selectedSessionId, locateRequest])
    const node = byId.get(selectedSessionId)
    if (lastLocate.current === key || !node) return
    const frame = requestAnimationFrame(() => {
      lastLocate.current = key
      setCamera((value) => ({ ...value, x: 24 - node.x * value.scale, y: 48 - node.y * value.scale }))
    })
    return () => cancelAnimationFrame(frame)
  }, [locateRequest, byId, selectedSessionId])
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-1 border-b p-2">
      <Button size="sm" variant="ghost" aria-label="缩小树状画布" onClick={() => setCamera(zoomDiagramCamera(measured(), Math.max(0.25, camera.scale / 1.2)))}>−</Button>
      <span className="text-xs tabular-nums">{Math.round(camera.scale * 100)}%</span>
      <Button size="sm" variant="ghost" aria-label="放大树状画布" onClick={() => setCamera(zoomDiagramCamera(measured(), Math.min(2, Math.max(0.25, camera.scale * 1.2))))}>+</Button>
      <Button size="sm" variant="ghost" onClick={() => { const next = measured(); setCamera(fitDiagramCamera({ width: Math.max(480, ...nodes.map((node) => node.x + 284)), height: Math.max(300, ...nodes.map((node) => node.y + 156)) }, next)) }}>适应画布</Button>
      <Button size="sm" variant="ghost" onClick={onLocate}>定位当前</Button>
    </div>
    <div ref={(element) => { viewport.current = element }} tabIndex={0} aria-label="会话分支画布，方向键平移，点击节点只读查看" className="relative min-h-0 flex-1 touch-none overflow-clip bg-muted/20 outline-offset-[-2px]"
      onFocus={() => { const next = measured(); if (next.width !== camera.width || next.height !== camera.height) setCamera(next) }}
      onKeyDown={(event) => { if (event.target !== event.currentTarget) return; const move = ({ ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] } as Record<string, number[]>)[event.key]; if (move) { event.preventDefault(); setCamera(panDiagramCamera(measured(), move[0], move[1])) } }}
      onPointerDown={(event) => { if (event.button !== 0 || (event.target as Element).closest('button')) return; drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={(event) => { if (!drag.current) return; const delta = { x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }; drag.current = { x: event.clientX, y: event.clientY }; setCamera((current) => panDiagramCamera({ ...current, width: viewport.current?.clientWidth || current.width, height: viewport.current?.clientHeight || current.height }, delta.x, delta.y)) }}
      onPointerUp={() => { drag.current = undefined }} onPointerCancel={() => { drag.current = undefined }}>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full text-muted-foreground/50">
        <g transform={`translate(${camera.x},${camera.y}) scale(${camera.scale})`}>
          {nodes.filter((node) => node.parent && (visibleIds.has(node.id) || visibleIds.has(node.parent))).map((node) => { const parent = byId.get(node.parent!); return parent && <path key={node.id} d={`M ${parent.x + 260} ${parent.y + 66} C ${parent.x + 290} ${parent.y + 66}, ${node.x - 24} ${node.y + 66}, ${node.x} ${node.y + 66}`} fill="none" stroke="currentColor" strokeWidth="1.5" /> })}
        </g>
      </svg>
      <div className="absolute origin-top-left" style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})` }}>
        {visible.map((node) => <div key={node.id} data-session-node={node.id} className="absolute h-[132px] w-[260px]" style={{ left: node.x, top: node.y }}>
          <button type="button" aria-pressed={node.id === selectedNodeId} title={node.label}
            className={`flex size-full flex-col gap-1 rounded-lg border bg-card p-3 text-left text-xs shadow-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${node.id === selectedNodeId ? 'ring-2 ring-primary' : node.id === selectedSessionId ? 'border-primary/60' : ''}`}
            onClick={() => onSelect(node)}>
            <span className="pr-6 text-muted-foreground">{node.id === selectedSessionId ? '当前会话' : '独立会话'}{node.status ? ` · ${node.status}` : ''}{node.id === selectedNodeId ? ' · 预览中' : ''}</span>
            <span className="w-full truncate font-medium">{node.label}</span>
            <span className="line-clamp-2 break-all text-muted-foreground">{node.summary}</span>
            {(node.notice || node.connectionLabel) && <span className={`mt-auto w-full truncate ${node.notice ? 'text-destructive' : 'text-muted-foreground'}`} title={[node.notice, node.connectionLabel, node.sourceEntryId && `来源节点 ${node.sourceEntryId}`].filter(Boolean).join(' · ')}>{node.notice || node.connectionLabel}</span>}
          </button>
          {node.hasChildren && <Button size="icon-sm" variant="ghost" className="absolute right-1 top-1" aria-label={`${node.collapsed ? '展开' : '折叠'} ${node.label} 的子会话`} aria-expanded={!node.collapsed} onClick={() => onToggle(node.id)}>{node.collapsed ? '+' : '−'}</Button>}
        </div>)}
      </div>
    </div>
  </div>
}
