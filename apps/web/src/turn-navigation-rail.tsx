import { type RefObject, useEffect, useRef, useState } from 'react'

import type { TimelineNavigationEntry } from './timeline-model.js'
import { nextOutlineAutoFollow } from './turn-navigation-rail-state.js'

function markerTop(index: number, count: number) {
  return count === 1 ? '50%' : `${(index / (count - 1)) * 100}%`
}

function markerLabel(entry: TimelineNavigationEntry) {
  return `第 ${entry.index} 轮：${entry.promptPreview}`
}

export function TurnNavigationRail({ entries, onJump, scrollViewport, timelineRoot }: {
  entries: TimelineNavigationEntry[]
  onJump: (turnId: string) => void
  scrollViewport: HTMLElement | null
  timelineRoot: RefObject<HTMLElement | null>
}) {
  const [activeTurnId, setActiveTurnId] = useState(() => entries.at(-1)?.id)
  const [open, setOpen] = useState(false)
  const outline = useRef<HTMLDivElement>(null)
  const pendingUserJumpTurnId = useRef<string | undefined>(undefined)
  const rail = useRef<HTMLDivElement>(null)

  const currentTurnId = entries.some((entry) => entry.id === activeTurnId) ? activeTurnId : entries.at(-1)?.id

  useEffect(() => {
    const root = timelineRoot.current
    if (!scrollViewport || !root || entries.length === 0) return
    const observer = new IntersectionObserver((observed) => {
      const visible = observed.filter((entry) => entry.isIntersecting)
      if (visible.length === 0) return
      visible.sort((left, right) => Math.abs(left.boundingClientRect.top - scrollViewport.getBoundingClientRect().top) - Math.abs(right.boundingClientRect.top - scrollViewport.getBoundingClientRect().top))
      setActiveTurnId((visible[0]!.target as HTMLElement).dataset.turnId)
    }, { root: scrollViewport, rootMargin: '-12% 0px -72% 0px', threshold: 0 })
    root.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [entries, scrollViewport, timelineRoot])

  useEffect(() => {
    if (pendingUserJumpTurnId.current && !entries.some((entry) => entry.id === pendingUserJumpTurnId.current)) pendingUserJumpTurnId.current = undefined
  }, [entries])

  useEffect(() => {
    if (!currentTurnId) return
    const autoFollow = nextOutlineAutoFollow(pendingUserJumpTurnId.current, currentTurnId)
    pendingUserJumpTurnId.current = autoFollow.pendingUserJumpTurnId
    if (!autoFollow.shouldFollow || !open || !outline.current) return
    const active = [...outline.current.querySelectorAll<HTMLElement>('[data-turn-outline-id]')].find((node) => node.dataset.turnOutlineId === currentTurnId)
    if (!active) return
    const top = active.offsetTop - outline.current.scrollTop
    const bottom = top + active.offsetHeight
    if (top < 0 || bottom > outline.current.clientHeight) outline.current.scrollTop = Math.max(0, active.offsetTop - (outline.current.clientHeight - active.offsetHeight) / 2)
  }, [currentTurnId, open])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !rail.current?.contains(event.target)) setOpen(false)
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

  return (
    <aside aria-label="对话轮次导航" className="hidden h-[min(58vh,28rem)] w-full shrink-0 overflow-visible md:sticky md:top-1/2 md:block md:-translate-y-1/2">
      <div className="relative grid h-full w-full place-items-center">
        <div className="group relative h-full w-5" ref={rail}>
          <button aria-controls="conversation-outline" aria-expanded={open} aria-label={open ? '收起历史输入目录' : '展开历史输入目录'} className="absolute inset-y-0 z-0 w-5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-timeline-rail="" onClick={() => setOpen((value) => !value)} type="button" />
        {entries.map((entry, index) => {
          const active = entry.id === currentTurnId
          return (
            <button aria-current={active ? 'location' : undefined} aria-label={markerLabel(entry)} className="absolute z-10 grid size-5 -translate-y-1/2 cursor-pointer place-items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-timeline-marker="" key={entry.id} onClick={(event) => { event.stopPropagation(); jump(entry.id) }} style={{ top: markerTop(index, entries.length) }} type="button">
              <span className={`block h-0.5 rounded-full transition-[width,background-color,opacity] ${active ? 'w-6 bg-primary group-hover:w-7 hover:w-7' : 'w-3 bg-muted-foreground/45 group-hover:bg-muted-foreground/60 hover:w-5 hover:bg-foreground'}`} />
            </button>
          )
        })}
        <div aria-hidden={!open} className={`absolute left-full top-1/2 z-20 flex max-h-[min(70vh,32rem)] w-80 -translate-y-1/2 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg transition-[opacity,transform] duration-150 ${open ? 'translate-x-0 opacity-100' : '-translate-x-2 pointer-events-none opacity-0'}`} id="conversation-outline">
          <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">历史输入</div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1" ref={outline}>
            {entries.map((entry) => {
              const active = entry.id === currentTurnId
              return (
                <button aria-current={active ? 'location' : undefined} aria-label={markerLabel(entry)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`} data-turn-outline-id={entry.id} key={entry.id} onClick={() => jump(entry.id)} tabIndex={open ? 0 : -1} type="button">
                  <span className="min-w-0 flex-1 truncate">{entry.promptPreview}</span>
                  <span aria-hidden="true" className={`block h-0.5 shrink-0 rounded-full ${active ? 'w-6 bg-primary' : 'w-3 bg-muted-foreground/55'}`} />
                </button>
              )
            })}
          </div>
        </div>
        </div>
      </div>
    </aside>
  )
}
