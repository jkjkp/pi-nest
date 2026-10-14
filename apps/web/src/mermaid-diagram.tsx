import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Maximize2, Minus, Plus, X } from 'lucide-react'
import { diagramConfig, fitDiagramScale, maxSourceLength, safeSvg } from './mermaid-render.js'

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

function DiagramMarkup({ diagram, scale }: { diagram: Diagram; scale: number }) {
  return <div className="shrink-0 [&_svg]:block [&_svg]:h-full! [&_svg]:w-full! [&_svg]:max-w-none!" style={{ width: diagram.width * scale, height: diagram.height * scale }} dangerouslySetInnerHTML={{ __html: diagram.svg }} />
}

function DiagramCanvas({ diagram, scale, onFit }: { diagram: Diagram; scale?: number; onFit?: (scale: number) => void }) {
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | undefined>(undefined)
  const [fit, setFit] = useState(1)
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const resize = () => {
      const next = fitDiagramScale(diagram, { width: element.clientWidth, height: element.clientHeight })
      setFit(next)
      onFit?.(next)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [diagram, onFit])
  return <div aria-label="图表画布，可拖动或滚动查看" className="min-h-0 flex-1 touch-none overflow-auto overscroll-contain rounded-md border bg-muted/20 outline-none focus-visible:ring-2 focus-visible:ring-ring" onLostPointerCapture={() => { drag.current = undefined }} onPointerDown={(event) => {
    if (event.button !== 0) return
    const element = event.currentTarget
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
    element.setPointerCapture(event.pointerId)
  }} onPointerMove={(event) => {
    const origin = drag.current
    if (!origin || origin.id !== event.pointerId) return
    event.currentTarget.scrollLeft = origin.left - (event.clientX - origin.x)
    event.currentTarget.scrollTop = origin.top - (event.clientY - origin.y)
  }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} ref={viewport} role="region" style={{ cursor: 'grab' }} tabIndex={0}>
    <div className="flex min-h-full min-w-full w-max items-center justify-center p-4 select-none"><DiagramMarkup diagram={diagram} scale={scale ?? fit} /></div>
  </div>
}

function DiagramViewer({ diagram, source, initialSource }: { diagram: Diagram; source: string; initialSource: boolean }) {
  const [showSource, setShowSource] = useState(initialSource)
  const [scale, setScale] = useState<number>()
  const [fit, setFit] = useState(1)
  const zoom = (factor: number) => setScale(Math.max(0.01, Math.min(4, (scale ?? fit) * factor)))
  return <DialogContent className="flex h-[92dvh] w-[94vw]! max-w-none flex-col gap-3 p-3 sm:p-4">
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <DialogTitle>Mermaid 图表</DialogTitle>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button disabled={showSource} onClick={() => setScale(undefined)} size="sm" type="button" variant="ghost">适合窗口</Button>
        <Button disabled={showSource} onClick={() => setScale(1)} size="sm" type="button" variant="ghost">100%</Button>
        <Button aria-label="缩小图表" disabled={showSource || (scale ?? fit) <= 0.01} onClick={() => zoom(0.8)} size="icon-sm" type="button" variant="ghost"><Minus /></Button>
        <Button aria-label="放大图表" disabled={showSource || (scale ?? fit) >= 4} onClick={() => zoom(1.25)} size="icon-sm" type="button" variant="ghost"><Plus /></Button>
        <DialogClose asChild><Button aria-label="关闭图表" size="icon-sm" type="button" variant="ghost"><X /></Button></DialogClose>
      </div>
    </div>
    <DialogDescription>缩放后拖动画布或使用滚动条查看；按 Esc 关闭。</DialogDescription>
    {showSource ? <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted p-4 text-xs leading-6"><code>{source}</code></pre> : <DiagramCanvas diagram={diagram} onFit={setFit} scale={scale} />}
    <div className="flex shrink-0 items-center gap-1">
      <Button aria-pressed={!showSource} onClick={() => setShowSource(false)} size="sm" type="button" variant={showSource ? 'ghost' : 'secondary'}>图表</Button>
      <Button aria-pressed={showSource} onClick={() => setShowSource(true)} size="sm" type="button" variant={showSource ? 'secondary' : 'ghost'}>源码</Button>
      {!showSource && <span aria-live="polite" className="ml-auto text-xs text-muted-foreground">{Math.round((scale ?? fit) * 100)}%</span>}
    </div>
  </DialogContent>
}

export function MermaidDiagram({ source }: { source: string }) {
  const [open, setOpen] = useState(false)
  const [initialSource, setInitialSource] = useState(false)
  const [rendered, setRendered] = useState<{ dark: boolean; error?: string; source: string; diagram?: Diagram }>()
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
      <div className="flex items-center gap-1"><Button onClick={() => show(true)} size="sm" type="button" variant="ghost">查看源码</Button><Button aria-label="放大查看 Mermaid 图表" onClick={() => show(false)} size="sm" type="button" variant="ghost"><Maximize2 />展开查看</Button></div>
    </figcaption>
    <div className="flex h-80">{!open && <DiagramCanvas diagram={current.diagram} />}</div>
    <Dialog onOpenChange={setOpen} open={open}>{open && <DiagramViewer diagram={current.diagram} initialSource={initialSource} source={source} />}</Dialog>
  </figure>
}
