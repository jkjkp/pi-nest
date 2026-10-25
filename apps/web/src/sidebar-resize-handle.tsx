import { useEffect, useRef, useState, type RefObject } from 'react'

import { clampSidebarWidth, maximumSidebarWidth, type SidebarPanel } from './sidebar-width.js'

export function SidebarResizeHandle({ containerRef, navigationWidth = 0, panel, width, onWidthChange }: {
  containerRef: RefObject<HTMLDivElement | null>
  navigationWidth?: number
  panel: SidebarPanel
  width: number
  onWidthChange: (width: number) => void
}) {
  const minimumWidth = panel === 'navigation' ? 220 : 240
  const label = panel === 'navigation' ? '调整会话导航宽度' : '调整文件预览宽度'
  const direction = panel === 'navigation' ? 1 : -1
  const offset = panel === 'navigation' ? 0 : navigationWidth
  const [available, setAvailable] = useState(0)
  const [resizing, setResizing] = useState(false)
  const drag = useRef<{ pointerId: number; x: number; width: number } | undefined>(undefined)
  const readAvailable = () => Math.max(0, (containerRef.current?.getBoundingClientRect().width ?? 0) - offset)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => setAvailable(Math.max(0, container.getBoundingClientRect().width - offset))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, offset])
  const currentWidth = clampSidebarWidth(width, available, panel)
  const maxWidth = maximumSidebarWidth(available, panel)

  function finish() {
    drag.current = undefined
    setResizing(false)
  }

  return <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={Math.min(minimumWidth, maxWidth)} aria-valuemax={maxWidth} aria-valuenow={currentWidth} aria-valuetext={`${currentWidth} 像素`} tabIndex={0}
    title={panel === 'navigation' ? '拖动调整会话导航宽度' : '拖动调整文件预览宽度，最多占正文与预览空间的一半'}
    className={`group/resize absolute inset-y-0 z-30 w-2 cursor-col-resize touch-none outline-none ${panel === 'navigation' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2'}`}
    data-resizing={resizing}
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, x: event.clientX, width: clampSidebarWidth(width, readAvailable(), panel) }
      setResizing(true)
    }}
    onPointerMove={(event) => {
      const start = drag.current
      if (!start || start.pointerId !== event.pointerId) return
      onWidthChange(clampSidebarWidth(Math.round(start.width + direction * (event.clientX - start.x)), readAvailable(), panel))
    }}
    onPointerUp={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return
      finish()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) finish() }}
    onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) finish() }}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 50 : 10
      const next = event.key === 'ArrowLeft' ? currentWidth - direction * step : event.key === 'ArrowRight' ? currentWidth + direction * step : event.key === 'Home' ? minimumWidth : event.key === 'End' ? maxWidth : undefined
      if (next === undefined) return
      event.preventDefault()
      onWidthChange(clampSidebarWidth(next, readAvailable(), panel))
    }}
  ><span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent group-hover/resize:bg-primary/60 group-focus-visible/resize:bg-primary group-data-[resizing=true]/resize:bg-primary" /></div>
}
