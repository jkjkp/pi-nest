import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TurnIndexEntry } from './history.js'
import { railAlignedOffset, railRowHeight, railScrollWindow, railWindowSize, railWindowStart } from './turn-navigation-rail-state.js'

export function TurnNavigationRail({ activeTurnId, entries, onJump, onReadPrompt, overlayRoot }: {
  activeTurnId?: string
  entries: TurnIndexEntry[]
  onJump: (turnId: string) => void | Promise<void>
  onReadPrompt?: (entry: TurnIndexEntry) => Promise<string>
  overlayRoot?: HTMLElement | null
}) {
  const [open, setOpen] = useState(false)
  const [outlineWindow, setOutlineWindow] = useState({ start: 0, moreAbove: false, moreBelow: false })
  const [hovered, setHovered] = useState<TurnIndexEntry>()
  const [preview, setPreview] = useState<{ text?: string; error?: string }>()
  const [jumpError, setJumpError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [layout, setLayout] = useState({ height: Math.min(10, entries.length) * railRowHeight, previewWidth: 360, previewHeight: 240, above: false })
  const root = useRef<HTMLElement>(null)
  const outline = useRef<HTMLDivElement>(null)
  const touch = useRef(false)
  const wasOpen = useRef(false)
  const jumpSequence = useRef(0)
  const outlineIndex = useRef(0)
  const outlineAtEnd = useRef(true)
  const previousCount = useRef(entries.length)
  const snapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const foundIndex = entries.findIndex((entry) => entry.id === activeTurnId)
  const currentIndex = foundIndex < 0 ? Math.max(0, entries.length - 1) : foundIndex
  const start = railWindowStart(entries.length, currentIndex)
  const count = Math.min(railWindowSize, entries.length)
  const rowHeight = Math.max(0, layout.height - 2) / Math.max(1, count)
  const windowStart = open ? outlineWindow.start : start
  const moreAbove = open ? outlineWindow.moreAbove : start > 0
  const moreBelow = open ? outlineWindow.moreBelow : start + count < entries.length
  // oxlint-disable-next-line react/incompatible-library -- The virtualizer owns DOM measurement state outside React.
  const virtualizer = useVirtualizer({ count: entries.length, estimateSize: () => rowHeight, getScrollElement: () => outline.current, getItemKey: (index) => entries[index]!.id, initialRect: { height: layout.height, width: 320 }, overscan: 2 })

  useLayoutEffect(() => {
    if (!root.current) return
    const measure = () => {
      const rect = root.current!.getBoundingClientRect()
      const width = (overlayRoot?.getBoundingClientRect().width ?? window.innerWidth) - 332
      const next = { height: rect.height, previewWidth: Math.min(380, Math.max(220, width)), previewHeight: Math.max(0, Math.min(240, rect.top - (overlayRoot?.getBoundingClientRect().top ?? 0) - 8)), above: width < 220 }
      setLayout((old) => old.height === next.height && old.previewWidth === next.previewWidth && old.previewHeight === next.previewHeight && old.above === next.above ? old : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root.current)
    if (overlayRoot) observer.observe(overlayRoot)
    return () => observer.disconnect()
  }, [overlayRoot, count])

  useLayoutEffect(() => { if (open && !wasOpen.current) virtualizer.scrollToIndex(start, { align: 'start' }); wasOpen.current = open }, [open, start, virtualizer])
  useEffect(() => { virtualizer.measure(); if (open) virtualizer.scrollToIndex(outlineIndex.current, { align: 'start' }) }, [open, rowHeight, virtualizer])
  useLayoutEffect(() => {
    if (open && previousCount.current !== entries.length && outlineAtEnd.current) virtualizer.scrollToIndex(entries.length - 1, { align: 'end' })
    previousCount.current = entries.length
  }, [entries.length, open, virtualizer])
  useEffect(() => () => clearTimeout(snapTimer.current), [open, rowHeight])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); setHovered(undefined) } }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [open])
  useEffect(() => {
    setPreview(undefined)
    if (!hovered || !open || !onReadPrompt) return
    let cancelled = false
    const timer = setTimeout(() => {
      setPreview({})
      void onReadPrompt(hovered).then((text) => { if (!cancelled) setPreview({ text }) }, () => { if (!cancelled) setPreview({ error: '读取失败，请重试' }) })
    }, touch.current ? 0 : 3000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [hovered, open, onReadPrompt, retry])

  function alignOutline(node: HTMLDivElement) {
    clearTimeout(snapTimer.current)
    const top = railAlignedOffset(node.scrollTop, rowHeight, node.scrollHeight - node.clientHeight)
    if (Math.abs(top - node.scrollTop) > 1) node.scrollTo({ top, behavior: 'auto' })
  }

  function openHistory() {
    if (open) return
    outlineIndex.current = start
    outlineAtEnd.current = start + count >= entries.length
    setOutlineWindow({ start, moreAbove: start > 0, moreBelow: start + count < entries.length })
    setOpen(true)
  }

  if (count < 2) return null
  async function jump(entry: TurnIndexEntry) {
    const sequence = ++jumpSequence.current
    setJumpError(false)
    try { await onJump(entry.id); if (sequence === jumpSequence.current) { setOpen(false); setHovered(undefined) } }
    catch { if (sequence === jumpSequence.current) setJumpError(true) }
  }
  const marker = (entry: TurnIndexEntry, fadeTop: boolean, fadeBottom: boolean) => <span aria-hidden="true" data-active-turn-marker={entry.id === entries[currentIndex]?.id ? entry.id : undefined} className={`h-0.5 rounded-full ${entry.id === entries[currentIndex]?.id ? 'w-4 bg-primary' : 'w-2.5 bg-muted-foreground/50'}`} style={fadeTop || fadeBottom ? { maskImage: `linear-gradient(to right, transparent, #000 80%)`, opacity: 0.45 } : undefined} data-edge-fade={fadeTop ? 'top' : fadeBottom ? 'bottom' : undefined} />
  const rail = <aside aria-label="对话轮次导航" className="pointer-events-auto absolute right-0 w-7" ref={root} style={{ height: `min(${count * railRowHeight}px, max(0px, calc(100% - var(--composer-height, 132px) - 48px)))`, top: 'calc((100% - var(--composer-height, 132px)) / 2)', transform: 'translateY(-50%)' }} onPointerEnter={(event) => { if (event.pointerType === 'mouse') { touch.current = false; openHistory() } }} onPointerLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !touch.current && !(document.activeElement instanceof HTMLElement && event.currentTarget.contains(document.activeElement) && document.activeElement.matches(':focus-visible'))) { setOpen(false); setHovered(undefined) } }} onFocusCapture={(event) => { if (!touch.current || (event.target instanceof HTMLElement && event.target.matches(':focus-visible'))) openHistory() }} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setHovered(undefined) } }} onPointerDown={(event) => { touch.current = event.pointerType === 'touch' }}>
    <div className="absolute inset-y-px right-0 z-30 flex w-7 flex-col" data-timeline-rail="" aria-expanded={open}>{entries.slice(windowStart, windowStart + count).map((entry, index) => <button aria-label={`第 ${entry.index} 轮：${entry.promptPreview}`} aria-current={entry.id === entries[currentIndex]?.id ? 'location' : undefined} className="flex min-h-0 flex-1 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-rail-marker="" key={entry.id} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const index = entries.indexOf(entry); const next = Math.max(0, Math.min(entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))); virtualizer.scrollToIndex(next, { align: 'auto' }); requestAnimationFrame(() => outline.current?.querySelector<HTMLButtonElement>(`[data-turn-index="${next}"]`)?.focus()) } }} onClick={() => touch.current && !open ? openHistory() : void jump(entry)} type="button">{marker(entry, moreAbove && index === 0, moreBelow && index === count - 1)}</button>)}</div>
    {open && <div className="absolute inset-y-0 right-0 z-20 w-[min(320px,calc(100vw-48px))] rounded-xl border bg-popover text-popover-foreground shadow-lg" role="region" aria-label="历史输入">
      <div className="turn-history-scroll absolute inset-y-0 right-7 left-0 overflow-y-auto overscroll-contain rounded-l-xl" ref={outline} onScroll={(event) => { setHovered(undefined); const node = event.currentTarget; const next = railScrollWindow(entries.length, rowHeight, node.scrollTop, node.scrollHeight, node.clientHeight); outlineIndex.current = next.start; outlineAtEnd.current = !next.moreBelow; setOutlineWindow((old) => old.start === next.start && old.moreAbove === next.moreAbove && old.moreBelow === next.moreBelow ? old : next); clearTimeout(snapTimer.current); snapTimer.current = setTimeout(() => alignOutline(node), 150) }} onScrollEnd={(event) => alignOutline(event.currentTarget)} onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
        const id = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-turn-outline-id]')?.dataset.turnOutlineId
        const index = entries.findIndex((entry) => entry.id === id)
        if (index < 0) return
        event.preventDefault()
        const next = Math.max(0, Math.min(entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
        virtualizer.scrollToIndex(next, { align: 'auto' })
        requestAnimationFrame(() => { outline.current?.querySelector<HTMLButtonElement>(`[data-turn-index="${next}"]`)?.focus() })
      }}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((item) => { const entry = entries[item.index]!; return <div className="absolute left-0 flex w-full items-center" key={entry.id} style={{ top: item.start, height: rowHeight }}><button aria-label={`第 ${entry.index} 轮：${entry.promptPreview}`} aria-current={entry.id === entries[currentIndex]?.id ? 'location' : undefined} className={`flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${entry.id === entries[currentIndex]?.id ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`} data-turn-index={item.index} data-turn-outline-id={entry.id} onFocus={(event) => { if (!event.currentTarget.matches(':focus-visible')) return; const text = event.currentTarget.querySelector('span'); if (text && text.scrollWidth > text.clientWidth) setHovered(entry); else setHovered(undefined) }} onClick={() => void jump(entry)} onPointerEnter={(event) => { const text = event.currentTarget.querySelector('span'); if (!touch.current && text && text.scrollWidth > text.clientWidth) setHovered(entry); else setHovered(undefined) }} onPointerLeave={(event) => { if (!root.current?.contains(event.relatedTarget as Node | null)) setHovered(undefined) }} type="button"><span className="min-w-0 flex-1 truncate">{entry.promptPreview}</span></button>{touch.current && <button aria-label={`查看第 ${entry.index} 轮完整消息`} className="shrink-0 px-2 text-xs" onClick={() => setHovered(entry)} type="button">查看</button>}</div> })}</div>
      </div>
      {preview && hovered && <div role="region" aria-label="完整用户消息" className="absolute z-30 max-h-[min(360px,40vh)] overflow-auto rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg" style={layout.above ? { ...(layout.previewHeight >= 80 ? { bottom: 'calc(100% + 8px)', maxHeight: layout.previewHeight } : { top: 0, maxHeight: layout.height }), right: 0, width: '100%' } : { right: '100%', top: 0, width: layout.previewWidth, maxHeight: layout.height }} onPointerDown={(event) => event.stopPropagation()}>{touch.current && <button aria-label="关闭完整消息" className="mb-2 text-xs underline" onClick={() => setHovered(undefined)} type="button">关闭</button>}{preview.text !== undefined ? <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{preview.text}</p> : preview.error ? <div role="alert">{preview.error}<button className="ml-2 underline" onClick={() => setRetry((value) => value + 1)} type="button">重试</button></div> : <p role="status">正在读取完整消息…</p>}</div>}
    </div>}
    {jumpError && <p role="alert" className="absolute top-full right-0 w-48 rounded border bg-popover p-2 text-xs text-destructive">跳转失败，请重试</p>}
  </aside>
  return overlayRoot ? createPortal(rail, overlayRoot) : rail
}
