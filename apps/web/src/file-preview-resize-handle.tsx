import { useEffect, useRef, useState, type RefObject } from 'react'

const minimumWidth = 240

function clampWidth(width: number, available: number) {
  const max = Math.max(0, Math.floor(available / 2))
  return Math.max(Math.min(minimumWidth, max), Math.min(max, Number.isFinite(width) ? width : 300))
}

export function FilePreviewResizeHandle({ containerRef, navigationWidth, width, onWidthChange }: {
  containerRef: RefObject<HTMLDivElement | null>
  navigationWidth: number
  width: number
  onWidthChange: (width: number) => void
}) {
  const [available, setAvailable] = useState(0)
  const [resizing, setResizing] = useState(false)
  const drag = useRef<{ pointerId: number; x: number; width: number } | undefined>(undefined)
  const readAvailable = () => Math.max(0, (containerRef.current?.getBoundingClientRect().width ?? 0) - navigationWidth)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => setAvailable(Math.max(0, container.getBoundingClientRect().width - navigationWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, navigationWidth])
  const currentWidth = clampWidth(width, available)
  const maxWidth = Math.max(0, Math.floor(available / 2))

  function finish() {
    drag.current = undefined
    setResizing(false)
  }

  return <div role="separator" aria-label="调整文件预览宽度" aria-orientation="vertical" aria-valuemin={Math.min(minimumWidth, maxWidth)} aria-valuemax={maxWidth} aria-valuenow={currentWidth} aria-valuetext={`${currentWidth} 像素`} tabIndex={0}
    title="拖动调整文件预览宽度，最多占正文与预览空间的一半"
    className="group/resize absolute inset-y-0 left-0 z-30 w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none"
    data-resizing={resizing}
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, x: event.clientX, width: clampWidth(width, readAvailable()) }
      setResizing(true)
    }}
    onPointerMove={(event) => {
      const start = drag.current
      if (!start || start.pointerId !== event.pointerId) return
      onWidthChange(clampWidth(Math.round(start.width + start.x - event.clientX), readAvailable()))
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
      const next = event.key === 'ArrowLeft' ? currentWidth + step : event.key === 'ArrowRight' ? currentWidth - step : event.key === 'Home' ? minimumWidth : event.key === 'End' ? maxWidth : undefined
      if (next === undefined) return
      event.preventDefault()
      onWidthChange(clampWidth(next, readAvailable()))
    }}
  ><span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent group-hover/resize:bg-primary/60 group-focus-visible/resize:bg-primary group-data-[resizing=true]/resize:bg-primary" /></div>
}
