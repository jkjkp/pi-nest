import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Maximize2, Minus, Plus, X } from 'lucide-react'
import { diagramConfig, maxSourceLength, safeSvg } from './mermaid-render.js'

import { fitDiagramCamera, panDiagramCamera, resizeDiagramCamera, zoomDiagramCamera, type DiagramCamera } from './diagram-camera.js'

import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

type Diagram = { svg: string; width: number; height: number }
let renderQueue: Promise<unknown> = Promise.resolve()

function useDarkMode() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setDark(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return dark
}

type CameraChange = (camera: DiagramCamera) => void

function CameraControls({ diagram, camera, onChange, disabled = false }: { diagram: Diagram; camera?: DiagramCamera; onChange: CameraChange; disabled?: boolean }) {
  const label = `${Number(((camera?.scale ?? 1) * 100).toFixed(1))}%`
  const zoom = (scale: number) => { if (camera) onChange(zoomDiagramCamera(camera, scale)) }
  return <div className="flex flex-wrap items-center gap-1">
    <Button disabled={disabled || !camera} onClick={() => { if (camera) onChange(fitDiagramCamera(diagram, camera)) }} size="sm" type="button" variant="ghost">适合窗口</Button>
    <Button disabled={disabled || !camera} onClick={() => zoom(1)} size="sm" type="button" variant="ghost">100%</Button>
    <Button aria-label="缩小图表" disabled={disabled || !camera || camera.scale <= 0.01} onClick={() => zoom(camera!.scale / 1.25)} size="icon-sm" type="button" variant="ghost"><Minus /></Button>
    <label className="flex items-center"><span className="sr-only">缩放比例</span><input aria-label="缩放比例" className="h-7 w-20 rounded border bg-background px-1 text-center text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" defaultValue={label} disabled={disabled || !camera} inputMode="decimal" key={label} onBlur={(event) => {
      const value = Number(event.currentTarget.value.trim().replace(/%$/, ''))
      if (Number.isFinite(value) && value > 0) zoom(value / 100)
      event.currentTarget.value = label
    }} onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
      if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.value = label; event.currentTarget.blur() }
    }} type="text" /></label>
    <Button aria-label="放大图表" disabled={disabled || !camera || camera.scale >= 16} onClick={() => zoom(camera!.scale * 1.25)} size="icon-sm" type="button" variant="ghost"><Plus /></Button>
  </div>
}

function DiagramCanvas({ diagram, camera, onChange }: { diagram: Diagram; camera?: DiagramCamera; onChange: CameraChange }) {
  const viewport = useRef<HTMLDivElement>(null)
  const latest = useRef(camera)
  const frame = useRef<number | undefined>(undefined)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const [dragging, setDragging] = useState(false)
  useLayoutEffect(() => { latest.current = camera }, [camera])
  const update = useCallback((next: DiagramCamera) => {
    latest.current = next
    if (frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => { frame.current = undefined; if (latest.current) onChange(latest.current) })
  }, [onChange])
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const resize = () => {
      if (!element.clientWidth || !element.clientHeight) return
      const next = resizeDiagramCamera(latest.current, diagram, { width: element.clientWidth, height: element.clientHeight })
      latest.current = next
      onChange(next)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [diagram, onChange])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      const current = latest.current
      if (!current) return
      event.preventDefault()
      event.stopPropagation()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
      // shortcut: wheel events do not identify hardware; small pixel deltas are treated as trackpad movement.
      if (!event.ctrlKey && (event.shiftKey || (event.deltaMode === 0 && (event.deltaX !== 0 || Math.abs(event.deltaY) < 50)))) {
        update(panDiagramCamera(current, -event.deltaX * unit, -event.deltaY * unit))
      } else {
        const rect = element.getBoundingClientRect()
        update(zoomDiagramCamera(current, current.scale * Math.exp(-event.deltaY * unit * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top }))
      }
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel); if (frame.current !== undefined) cancelAnimationFrame(frame.current) }
  }, [update])
  const release = (id: number) => { pointers.current.delete(id); setDragging(pointers.current.size > 0) }
  return <div aria-label="图表画布，可缩放和自由平移" className="relative min-h-0 flex-1 touch-none overflow-hidden overscroll-contain rounded-md border bg-muted/20 outline-none focus-visible:outline-1 focus-visible:outline-border" onLostPointerCapture={(event) => release(event.pointerId)} onPointerDown={(event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    const rect = event.currentTarget.getBoundingClientRect()
    pointers.current.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top })
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }} onPointerMove={(event) => {
    const current = latest.current
    const previous = pointers.current.get(event.pointerId)
    if (!current || !previous) return
    const rect = event.currentTarget.getBoundingClientRect()
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1]
    pointers.current.set(event.pointerId, point)
    if (other) {
      const before = Math.hypot(previous.x - other.x, previous.y - other.y)
      const after = Math.hypot(point.x - other.x, point.y - other.y)
      if (before < 1) return
      const center = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 }
      update(panDiagramCamera(zoomDiagramCamera(current, current.scale * after / before, center), (point.x - previous.x) / 2, (point.y - previous.y) / 2))
    } else update(panDiagramCamera(current, point.x - previous.x, point.y - previous.y))
  }} onPointerUp={(event) => { release(event.pointerId); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={(event) => release(event.pointerId)} onKeyDown={(event) => {
    const current = latest.current
    if (!current) return
    const arrows: Record<string, [number, number]> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }
    if (arrows[event.key]) { event.preventDefault(); update(panDiagramCamera(current, ...arrows[event.key]!)) }
    else if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); update(zoomDiagramCamera(current, current.scale * (event.key === '-' ? 0.8 : 1.25))) }
    else if (event.key === '0') { event.preventDefault(); update(fitDiagramCamera(diagram, current)) }
  }} ref={viewport} role="region" style={{ cursor: dragging ? 'grabbing' : 'grab' }} tabIndex={0}>
    <div aria-hidden={!camera} className="pointer-events-none absolute left-0 top-0 origin-top-left select-none [&_svg]:block [&_svg]:h-full! [&_svg]:w-full! [&_svg]:max-w-none!" style={{ width: diagram.width, height: diagram.height, opacity: camera ? 1 : 0, transform: camera ? `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` : undefined }} dangerouslySetInnerHTML={{ __html: diagram.svg }} />
  </div>
}

function DiagramViewer({ diagram, source, initialSource, camera, onChange }: { diagram: Diagram; source: string; initialSource: boolean; camera?: DiagramCamera; onChange: CameraChange }) {
  const [showSource, setShowSource] = useState(initialSource)
  return <DialogContent className="flex h-[92dvh] w-[94vw]! max-w-none flex-col gap-3 p-3 sm:p-4">
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <DialogTitle>Mermaid 图表</DialogTitle>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <CameraControls camera={camera} diagram={diagram} disabled={showSource} onChange={onChange} />
        <DialogClose asChild><Button aria-label="关闭图表" size="icon-sm" type="button" variant="ghost"><X /></Button></DialogClose>
      </div>
    </div>
    <DialogDescription>滚轮缩放、拖动画布查看；可输入 1%–1600%，按 Esc 关闭。</DialogDescription>
    {showSource ? <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted p-4 text-xs leading-6"><code>{source}</code></pre> : <DiagramCanvas camera={camera} diagram={diagram} onChange={onChange} />}
    <div className="flex shrink-0 items-center gap-1">
      <Button aria-pressed={!showSource} onClick={() => setShowSource(false)} size="sm" type="button" variant={showSource ? 'ghost' : 'secondary'}>图表</Button>
      <Button aria-pressed={showSource} onClick={() => setShowSource(true)} size="sm" type="button" variant={showSource ? 'secondary' : 'ghost'}>源码</Button>
    </div>
  </DialogContent>
}

export function MermaidDiagram({ source }: { source: string }) {
  const [open, setOpen] = useState(false)
  const [initialSource, setInitialSource] = useState(false)
  const [rendered, setRendered] = useState<{ dark: boolean; error?: string; source: string; diagram?: Diagram }>()
  const [view, setView] = useState<{ source: string; camera: DiagramCamera }>()
  const camera = view?.source === source ? view.camera : undefined
  const changeCamera = useCallback((camera: DiagramCamera) => setView({ source, camera }), [source])
  const dark = useDarkMode()
  const id = useId().replaceAll(':', '')
  const current = rendered?.source === source && rendered.dark === dark ? rendered : undefined

  useEffect(() => {
    let cancelled = false
    if (source.length > maxSourceLength) return
    const render = async () => {
      if (cancelled) return
      const [{ default: mermaid }, { default: purifier }] = await Promise.all([import('mermaid'), import('dompurify')])
      mermaid.initialize(diagramConfig(dark))
      const result = await mermaid.render(`pi-nest-mermaid-${id}`, source)
      const svg = safeSvg(purifier, result.svg)
      const element = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
      const bounds = element.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
      const width = bounds?.[2] ?? Number.parseFloat(element.getAttribute('width') ?? '')
      const height = bounds?.[3] ?? Number.parseFloat(element.getAttribute('height') ?? '')
      if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error('Invalid diagram dimensions')
      if (!cancelled) setRendered({ dark, source, diagram: { svg, width, height } })
    }
    // Mermaid shares configuration; keep initialize + render together across diagrams and themes.
    renderQueue = renderQueue.then(render).catch(() => { if (!cancelled) setRendered({ dark, error: '图表无法渲染。', source }) })
    return () => { cancelled = true }
  }, [dark, id, source])

  if (source.length > maxSourceLength || current?.error) return <div className="my-3"><pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs leading-6"><code>{source}</code></pre><p className="mt-2 text-sm text-destructive">{current?.error ?? '图表源码超过 32 KiB 上限。'}</p></div>
  if (!current?.diagram) return <div className="my-3 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">正在生成 Mermaid 图表…</div>
  const show = (source: boolean) => { setInitialSource(source); setOpen(true) }
  return <figure className="my-3 rounded-md border bg-card p-3">
    <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
      Mermaid 图表
      <div className="flex flex-wrap items-center gap-1"><CameraControls camera={camera} diagram={current.diagram} onChange={changeCamera} /></div>
      <div className="flex items-center gap-1"><Button onClick={() => show(true)} size="sm" type="button" variant="ghost">查看源码</Button><Button aria-label="放大查看 Mermaid 图表" onClick={() => show(false)} size="sm" type="button" variant="ghost"><Maximize2 />展开查看</Button></div>
    </figcaption>
    <div className="flex h-80">{!open && <DiagramCanvas camera={camera} diagram={current.diagram} onChange={changeCamera} />}</div>
    <Dialog onOpenChange={setOpen} open={open}>{open && <DiagramViewer camera={camera} diagram={current.diagram} initialSource={initialSource} onChange={changeCamera} source={source} />}</Dialog>
  </figure>
}
