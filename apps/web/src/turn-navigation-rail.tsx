import { type RefObject, useEffect, useMemo, useState } from 'react'
import { List } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import type { TimelineNavigationEntry } from './timeline-model.js'
import { formatUpdatedAt } from './workspace.js'

type MarkerGroup = {
  entries: TimelineNavigationEntry[]
  target: TimelineNavigationEntry
}

function markerGroups(entries: TimelineNavigationEntry[]) {
  const perGroup = Math.ceil(entries.length / 36)
  const groups: MarkerGroup[] = []
  for (let start = 0; start < entries.length; start += perGroup) {
    const groupEntries = entries.slice(start, start + perGroup)
    groups.push({ entries: groupEntries, target: groupEntries[Math.floor(groupEntries.length / 2)]! })
  }
  return groups
}

function markerLabel(group: MarkerGroup) {
  const first = group.entries[0]!
  const last = group.entries.at(-1)!
  const range = first.index === last.index ? `第 ${first.index} 轮` : `第 ${first.index}–${last.index} 轮`
  return `${range}：${first.promptPreview}`
}

export function TurnNavigationRail({ entries, onJump, scrollViewport, timelineRoot }: {
  entries: TimelineNavigationEntry[]
  onJump: (turnId: string) => void
  scrollViewport: HTMLElement | null
  timelineRoot: RefObject<HTMLElement | null>
}) {
  const [activeTurnId, setActiveTurnId] = useState<string>()
  const groups = useMemo(() => markerGroups(entries), [entries])

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

  if (groups.length === 0) return null
  return (
    <aside aria-label="对话轮次导航" className="hidden self-start md:sticky md:top-5 md:block md:h-[min(62vh,32rem)]">
      <div className="relative h-full before:absolute before:top-0 before:bottom-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border">
        {groups.map((group, index) => {
          const active = group.entries.some((entry) => entry.id === activeTurnId)
          const top = groups.length === 1 ? '50%' : `${(index / (groups.length - 1)) * 100}%`
          return (
            <Tooltip key={group.target.id}>
              <TooltipTrigger asChild>
                <button aria-current={active ? 'location' : undefined} aria-label={markerLabel(group)} className={`absolute left-1/2 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[width,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? 'w-6 bg-foreground' : 'w-2 bg-muted-foreground/55 hover:w-4 hover:bg-foreground'}`} onClick={() => onJump(group.target.id)} style={{ top }} type="button" />
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={10}><span className="block font-medium">{markerLabel(group)}</span><span className="block text-background/70">{formatUpdatedAt(group.target.startedAt)}</span></TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </aside>
  )
}

export function TurnNavigationSheet({ entries, onJump }: { entries: TimelineNavigationEntry[]; onJump: (turnId: string) => void }) {
  const [open, setOpen] = useState(false)
  if (entries.length === 0) return null
  return (
    <div className="mb-3 md:hidden">
      <Sheet onOpenChange={setOpen} open={open}>
        <SheetTrigger asChild><Button size="sm" type="button" variant="ghost"><List />对话轮次</Button></SheetTrigger>
        <SheetContent className="flex flex-col gap-3" side="left">
          <SheetTitle>对话轮次</SheetTitle>
          <SheetDescription>选择一轮并定位到对应的用户请求。</SheetDescription>
          <div className="min-h-0 space-y-1 overflow-y-auto">{entries.map((entry) => <button className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" key={entry.id} onClick={() => { setOpen(false); onJump(entry.id) }} type="button"><span className="block font-medium">第 {entry.index} 轮</span><span className="block truncate text-xs text-muted-foreground">{entry.promptPreview}</span></button>)}</div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
