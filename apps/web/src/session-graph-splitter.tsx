import { useRef, type RefObject } from 'react'
import { clampGraphSplitRatio } from './session-graph-model.js'

export function SessionGraphSplitter({ containerRef, width, ratio, onChange, onCommit }: {
  containerRef: RefObject<HTMLDivElement | null>; width: number; ratio: number
  onChange: (ratio: number) => void; onCommit: (ratio: number) => void
}) {
  const drag = useRef<{ pointerId: number; offset: number; ratio: number } | undefined>(undefined)
  function finish(pointerId: number) {
    if (drag.current?.pointerId !== pointerId) return
    const next = drag.current.ratio
    drag.current = undefined
    onCommit(next)
  }
  return <div role="separator" tabIndex={0} aria-label="调整画布与对话宽度" title="拖动调整画布与对话宽度" aria-orientation="vertical" aria-controls="session-graph-panel"
    aria-valuemin={Math.round(clampGraphSplitRatio(0, width) * 100)} aria-valuemax={Math.round(clampGraphSplitRatio(1, width) * 100)} aria-valuenow={Math.round(ratio * 100)} aria-valuetext={`画布 ${Math.round(ratio * 100)}%，对话 ${Math.round((1 - ratio) * 100)}%`}
    className="group/resize absolute inset-y-0 right-0 z-30 w-2 translate-x-1/2 cursor-col-resize touch-none outline-none"
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect?.width) return
      event.preventDefault(); event.stopPropagation()
      event.currentTarget.focus({ preventScroll: true })
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, offset: event.clientX - rect.left - ratio * rect.width, ratio }
      onChange(ratio)
    }}
    onPointerMove={(event) => {
      const current = drag.current
      if (!current || current.pointerId !== event.pointerId) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect?.width) return
      current.ratio = clampGraphSplitRatio((event.clientX - rect.left - current.offset) / rect.width, rect.width)
      onChange(current.ratio)
    }}
    onPointerUp={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return
      finish(event.pointerId)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }} onPointerCancel={(event) => finish(event.pointerId)} onLostPointerCapture={(event) => finish(event.pointerId)}
    onKeyDown={(event) => {
      if (drag.current || width <= 0) return
      const step = (event.shiftKey ? 50 : 10) / width
      const next = event.key === 'ArrowLeft' ? ratio - step : event.key === 'ArrowRight' ? ratio + step : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : undefined
      if (next === undefined) return
      event.preventDefault()
      onCommit(clampGraphSplitRatio(next, width))
    }}
  ><span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent group-hover/resize:bg-primary/60 group-focus-visible/resize:bg-primary" /></div>
}
