import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'

import type { TurnIndexEntry } from './history.js'
import { computeIdleRailViewportLayout, computeOutlineViewportLayout, computeRailViewportLayout, densityBins, focusWindow, jumpFromMarker, jumpFromOutline, nextOutlineAutoFollow, nextRailIndex, openOutlineFromContextMenu, railIdleHeight, railIndexFromPointer, railMode, turnRatio, type RailViewportLayout } from './turn-navigation-rail-state.js'
import { formatUpdatedAt } from './workspace.js'

function markerY(index: number, count: number) {
  return turnRatio(index, count) * 1_000
}

function markerLabel(entry: TurnIndexEntry) {
  return `第 ${entry.index} 轮：${entry.promptPreview}`
}

type RailLayouts = { expanded: RailViewportLayout; idle: RailViewportLayout; outline: RailViewportLayout }
const railLayoutKeys = ['expanded', 'idle', 'outline'] as const

export function TurnNavigationRail({ activeTurnId, entries, onJump, overlayRoot, scrollViewport }: {
  activeTurnId?: string
  entries: TurnIndexEntry[]
  onJump: (turnId: string) => void
  overlayRoot?: HTMLElement | null
  scrollViewport?: HTMLElement | null
}) {
  const [open, setOpen] = useState(false)
  const [hoveredIndex, setHoveredIndex] = useState<number | undefined>(undefined)
  const [keyboardIndex, setKeyboardIndex] = useState<number | undefined>(undefined)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  const [layouts, setLayouts] = useState<RailLayouts | undefined>(undefined)
  const outline = useRef<HTMLDivElement>(null)
  const pendingUserJumpTurnId = useRef<string | undefined>(undefined)
  const pointerFocus = useRef(false)
  const railRoot = useRef<HTMLDivElement>(null)
  const currentTurnId = entries.some((entry) => entry.id === activeTurnId) ? activeTurnId : entries.at(-1)?.id
  const currentIndex = Math.max(0, entries.findIndex((entry) => entry.id === currentTurnId))
  const mode = railMode(entries.length)
  const density = useMemo(() => mode === 'density' ? densityBins(entries.length) : [], [entries.length, mode])
  const focused = useMemo(() => mode === 'density' ? focusWindow(currentIndex, entries.length) : [], [currentIndex, entries.length, mode])
  // oxlint-disable-next-line react/incompatible-library -- The virtualizer owns DOM measurement state outside React.
  const outlineVirtualizer = useVirtualizer({
    count: entries.length,
    estimateSize: () => 72,
    getItemKey: (index) => entries[index]!.id,
    getScrollElement: () => outline.current,
    initialRect: { height: 400, width: 360 },
    overscan: 5,
  })

  useLayoutEffect(() => {
    if (!overlayRoot || !scrollViewport) {
      setLayouts(undefined)
      return
    }
    const measure = () => {
      const overlay = overlayRoot.getBoundingClientRect()
      const viewport = scrollViewport.getBoundingClientRect()
      const viewportTop = Math.max(0, Math.min(overlay.height, viewport.top - overlay.top))
      const viewportBottom = Math.max(viewportTop, Math.min(overlay.height, viewport.bottom - overlay.top))
      const viewportHeight = Math.max(0, viewportBottom - viewportTop)
      const idle = computeIdleRailViewportLayout({ viewportHeight })
      const expanded = computeRailViewportLayout({ viewportHeight })
      const outline = computeOutlineViewportLayout({ centerY: idle.top + idle.height / 2, viewportHeight })
      const positioned: RailLayouts = {
        expanded: { ...expanded, bottom: viewportTop + expanded.bottom, top: viewportTop + expanded.top },
        idle: { ...idle, bottom: viewportTop + idle.bottom, top: viewportTop + idle.top },
        outline: { ...outline, bottom: viewportTop + outline.bottom, top: viewportTop + outline.top },
      }
      setLayouts((current) => current && railLayoutKeys.every((key) => current[key].top === positioned[key].top && current[key].height === positioned[key].height) ? current : positioned)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(overlayRoot)
    if (scrollViewport !== overlayRoot) observer.observe(scrollViewport)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [overlayRoot, scrollViewport])

  useEffect(() => {
    if (pendingUserJumpTurnId.current && !entries.some((entry) => entry.id === pendingUserJumpTurnId.current)) pendingUserJumpTurnId.current = undefined
  }, [entries])

  useEffect(() => {
    if (!currentTurnId) return
    const autoFollow = nextOutlineAutoFollow(pendingUserJumpTurnId.current, currentTurnId)
    pendingUserJumpTurnId.current = autoFollow.pendingUserJumpTurnId
    if (autoFollow.shouldFollow && open) outlineVirtualizer.scrollToIndex(currentIndex, { align: 'auto' })
  }, [currentIndex, currentTurnId, open, outlineVirtualizer])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !railRoot.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  if (entries.length === 0) return null

  function jump(turnId: string) {
    if (turnId !== currentTurnId) pendingUserJumpTurnId.current = turnId
    onJump(turnId)
  }

  function indexAtPointer(clientY: number, target: SVGSVGElement) {
    return railIndexFromPointer(clientY, target.getBoundingClientRect(), entries.length)
  }

  function jumpAt(index: number) {
    setKeyboardIndex(index)
    jumpFromMarker(jump, entries[index]!.id)
  }

  const hoverIndex = hoveredIndex === undefined ? undefined : Math.min(entries.length - 1, hoveredIndex)
  const interactionIndex = keyboardIndex === undefined ? hoverIndex ?? currentIndex : Math.min(entries.length - 1, keyboardIndex)
  const expanded = hoverIndex !== undefined || keyboardFocused
  const railLayout = layouts?.[expanded ? 'expanded' : 'idle']
  const railStyle = railLayout ? { height: `${railLayout.height}px`, maxHeight: 'calc(100% - 48px)', top: `${railLayout.top}px`, transform: 'none' } : { height: `${railIdleHeight}px`, maxHeight: 'calc(100% - 48px)', top: '50%', transform: 'translateY(-50%)' }
  const outlineStyle = layouts && railLayout
    ? { height: `${layouts.outline.height}px`, top: `${layouts.outline.top - railLayout.top}px`, transform: 'none' }
    : { top: '50%', transform: 'translateY(-50%)' }
  const rail = (
    <aside aria-label="对话轮次导航" className="pointer-events-auto hidden shrink-0 overflow-visible transition-[height,top] duration-150 md:absolute md:left-0 md:block md:w-8" style={railStyle}>
      <div className="relative grid h-full w-full place-items-center">
        <div className="relative h-full w-7" ref={railRoot}>
          <svg aria-controls="conversation-outline" aria-expanded={open} aria-label={`对话轮次导航，共 ${entries.length} 轮；右键打开历史输入`} aria-orientation="vertical" aria-valuemax={entries.length} aria-valuemin={1} aria-valuenow={interactionIndex + 1} aria-valuetext={`第 ${entries[interactionIndex]!.index} 轮`} className={`h-full w-7 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${hoverIndex === undefined && !keyboardFocused ? 'text-muted-foreground' : 'text-foreground'}`} data-rail-mode={mode} data-timeline-rail="" onBlur={() => setKeyboardFocused(false)} onClick={(event) => jumpAt(indexAtPointer(event.clientY, event.currentTarget))} onContextMenu={(event) => {
            pointerFocus.current = false
            setHoveredIndex(undefined)
            setKeyboardFocused(false)
            openOutlineFromContextMenu(event, () => setOpen(true))
          }} onFocus={() => {
            if (!pointerFocus.current) setKeyboardFocused(true)
            pointerFocus.current = false
          }} onKeyDown={(event) => {
            setKeyboardFocused(true)
            const next = nextRailIndex(event.key, interactionIndex, entries.length)
            if (next !== undefined) {
              event.preventDefault()
              jumpAt(next)
            } else if ((event.key === 'Enter' || event.key === ' ') && interactionIndex >= 0) {
              event.preventDefault()
              jumpAt(interactionIndex)
            }
          }} onPointerDown={() => { pointerFocus.current = true }} onPointerLeave={() => setHoveredIndex(undefined)} onPointerMove={(event) => {
            const next = indexAtPointer(event.clientY, event.currentTarget)
            setHoveredIndex((previous) => previous === next ? previous : next)
          }} role="slider" tabIndex={0} viewBox="0 0 28 1000">
            <path d="M 14 0 V 1000" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
            {mode === 'detailed' && entries.map((entry, index) => <path d={`M 10 ${markerY(index, entries.length)} H 18`} data-rail-marker="" fill="none" key={entry.id} stroke="currentColor" strokeLinecap="round" strokeOpacity="0.32" strokeWidth="2" />)}
            {mode === 'compact' && entries.map((entry, index) => <path d={`M 11 ${markerY(index, entries.length)} H 17`} data-rail-marker="" fill="none" key={entry.id} stroke="currentColor" strokeLinecap="round" strokeOpacity="0.25" strokeWidth="1" />)}
            {mode === 'density' && density.map((bin, index) => <path d={`M 14 ${bin.startRatio * 1_000} V ${bin.endRatio * 1_000}`} data-rail-density-bin="" fill="none" key={index} stroke="currentColor" strokeLinecap="round" strokeOpacity={Math.min(0.35, 0.14 + bin.count / 100)} strokeWidth="2" />)}
            {mode === 'density' && focused.filter((index) => index !== currentIndex).map((index) => <path d={`M 7 ${markerY(index, entries.length)} H 21`} data-rail-focus-marker="" fill="none" key={entries[index]!.id} stroke="currentColor" strokeLinecap="round" strokeOpacity="0.58" strokeWidth="2" />)}
            <path d={`M 0 ${markerY(currentIndex, entries.length)} H 28`} className="text-primary" data-active-turn-marker={currentTurnId} fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
            {hoverIndex !== undefined && hoverIndex !== currentIndex && <path d={`M 5 ${markerY(hoverIndex, entries.length)} H 23`} className="text-foreground" data-hovered-turn-marker="" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />}
          </svg>
          <div aria-hidden={!open} className={`absolute left-full z-20 flex w-[23rem] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg transition-[height,opacity,top,transform] duration-150 ${open ? 'translate-x-0 opacity-100' : '-translate-x-2 pointer-events-none opacity-0'}`} id="conversation-outline" style={outlineStyle}>
            <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">历史输入</div>
            {open && <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1" ref={outline}>
              <div className="relative w-full" style={{ height: `${outlineVirtualizer.getTotalSize()}px` }}>
                {outlineVirtualizer.getVirtualItems().map((virtualItem) => {
                  const entry = entries[virtualItem.index]!
                  const active = entry.id === currentTurnId
                  return <button aria-current={active ? 'location' : undefined} aria-label={markerLabel(entry)} className={`absolute left-0 flex w-full flex-col items-start gap-1 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`} data-turn-outline-id={entry.id} key={virtualItem.key} onClick={() => jumpFromOutline(jump, () => setOpen(false), entry.id)} ref={outlineVirtualizer.measureElement} style={{ transform: `translateY(${virtualItem.start}px)` }} type="button">
                    <span className="text-xs font-medium text-muted-foreground">第 {entry.index} 轮 · <time dateTime={entry.startedAt}>{formatUpdatedAt(entry.startedAt)}</time></span>
                    <span className="w-full whitespace-pre-wrap break-words text-sm leading-5 line-clamp-3">{entry.promptPreview}</span>
                  </button>
                })}
              </div>
            </div>}
          </div>
        </div>
      </div>
    </aside>
  )

  return overlayRoot ? createPortal(rail, overlayRoot) : rail
}
