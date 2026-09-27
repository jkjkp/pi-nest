import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

import { AssistantMarkdown } from './assistant-markdown.js'
import { historyPageCursorForTurn, type PiSessionHistoryResponse, type PiSessionTurnIndex } from './history.js'
import { prependedScrollTop, turnJumpAlignment, type TurnJumpAlignment } from './timeline-pagination.js'
import { timelineNavigationTurns } from './timeline-navigation.js'
import { timelineItems, type RuntimeTurn, type TimelineItem } from './timeline-model.js'
import type { PiRuntimeEvent } from './runtime-websocket-client.js'
import { TurnNavigationRail } from './turn-navigation-rail.js'
import { TurnExecution } from './turn-execution.js'
import { projectTurnPresentation } from './turn-execution-model.js'
import { promptOverflows } from './user-prompt-state.js'
import { formatUpdatedAt } from './workspace.js'

export function SessionTimeline({ error, hasEarlier = false, history, isLoading, isLoadingEarlier = false, isRunning = false, onFinalAnswerStart, onFinalAnswerStream, onJumpToTurn, onJumpToUnloadedTurn, onLoadEarlier, onPendingJumpHandled, onRetry, overlayRoot, pendingJumpTurnId, scrollViewport, systemEvents = [], turnIndex, turns = [] }: {
  error: boolean
  hasEarlier?: boolean
  history: PiSessionHistoryResponse | undefined
  isLoading: boolean
  isLoadingEarlier?: boolean
  isRunning?: boolean
  onFinalAnswerStart?: (turnId: string) => void
  onFinalAnswerStream?: () => void
  onJumpToTurn?: (turnId: string, scrollTo: (behavior: ScrollBehavior) => void, alignment: TurnJumpAlignment) => void
  onJumpToUnloadedTurn?: (turnId: string, cursor: string | undefined) => void
  onLoadEarlier?: () => void
  onPendingJumpHandled?: () => void
  onRetry: () => void
  overlayRoot?: HTMLElement | null
  pendingJumpTurnId?: string
  scrollViewport?: HTMLElement | null
  systemEvents?: PiRuntimeEvent[]
  turnIndex?: PiSessionTurnIndex
  turns?: RuntimeTurn[]
}) {
  const prependAnchor = useRef<{ firstTurnId: string | undefined; scrollHeight: number; scrollTop: number } | undefined>(undefined)
  const historyLoadRequested = useRef(false)
  const [canLoadEarlier, setCanLoadEarlier] = useState(false)
  const items = useMemo(() => timelineItems(history?.entries, turns, systemEvents), [history?.entries, systemEvents, turns])
  const persistedIndex = turnIndex && turnIndex.revision === history?.revision ? turnIndex.entries : undefined
  const railEntries = useMemo(() => timelineNavigationTurns(persistedIndex, items), [items, persistedIndex])
  // oxlint-disable-next-line react/incompatible-library -- The virtualizer owns DOM measurement state outside React.
  const virtualizer = useVirtualizer({
    count: items.length + 1,
    estimateSize: (index) => index === 0 ? 20 : 240,
    getItemKey: (index) => index === 0 ? 'history-load-sentinel' : items[index - 1]!.id,
    getScrollElement: () => scrollViewport ?? null,
    initialRect: { height: 800, width: 0 },
    overscan: 8,
    useAnimationFrameWithResizeObserver: true,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const activeVirtualItem = virtualizer.getVirtualItemForOffset((virtualizer.scrollOffset ?? 0) + 48)
  const activeTurnId = items[Math.max(0, (activeVirtualItem?.index ?? 1) - 1)]?.id
  useEffect(() => {
    setCanLoadEarlier(false)
    historyLoadRequested.current = false
  }, [history?.session.id])
  useEffect(() => {
    if ((virtualizer.scrollOffset ?? 0) > 0) setCanLoadEarlier(true)
  }, [virtualizer.scrollOffset])
  useEffect(() => {
    if (!isLoadingEarlier) historyLoadRequested.current = false
  }, [isLoadingEarlier])
  const loadEarlier = useCallback(() => {
    if (!hasEarlier || isLoadingEarlier || !onLoadEarlier) return
    if (scrollViewport) prependAnchor.current = { firstTurnId: items[0]?.id, scrollHeight: scrollViewport.scrollHeight, scrollTop: scrollViewport.scrollTop }
    onLoadEarlier()
  }, [hasEarlier, isLoadingEarlier, items, onLoadEarlier, scrollViewport])

  useLayoutEffect(() => {
    const anchor = prependAnchor.current
    if (!anchor || !scrollViewport || items[0]?.id === anchor.firstTurnId) return
    scrollViewport.scrollTo({ top: prependedScrollTop(anchor.scrollHeight, anchor.scrollTop, scrollViewport.scrollHeight) })
    prependAnchor.current = undefined
  }, [items, scrollViewport])

  useLayoutEffect(() => {
    if (!pendingJumpTurnId) return
    const index = items.findIndex((item) => item.id === pendingJumpTurnId)
    if (index < 0) return
    const alignment = turnJumpAlignment(pendingJumpTurnId, railEntries.at(-1)?.id)
    const scrollTo = (behavior: ScrollBehavior) => virtualizer.scrollToIndex(index + 1, { align: alignment, behavior })
    if (onJumpToTurn) onJumpToTurn(pendingJumpTurnId, scrollTo, alignment)
    else scrollTo('auto')
    onPendingJumpHandled?.()
  }, [items, onJumpToTurn, onPendingJumpHandled, pendingJumpTurnId, railEntries, virtualizer])

  if (isLoading) return <LoadingTimeline />
  if (error) return <HistoryError onRetry={onRetry} />

  if (items.length === 0) {
    return <section className="py-8 text-center"><p className="text-sm text-muted-foreground">{isRunning ? '正在等待 Pi 原生事件…' : '当前活动分支尚无可展示的原生条目。'}</p></section>
  }

  const jump = (turnId: string) => {
    const index = items.findIndex((item) => item.id === turnId)
    if (index < 0) return void onJumpToUnloadedTurn?.(turnId, historyPageCursorForTurn(railEntries, turnId))
    const alignment = turnJumpAlignment(turnId, railEntries.at(-1)?.id)
    const scrollTo = (behavior: ScrollBehavior) => virtualizer.scrollToIndex(index + 1, { align: alignment, behavior })
    if (onJumpToTurn) onJumpToTurn(turnId, scrollTo, alignment)
    else scrollTo('auto')
  }
  return <section className="conversation-stage pb-6">{overlayRoot !== null && <TurnNavigationRail activeTurnId={activeTurnId} entries={railEntries} onJump={jump} overlayRoot={overlayRoot} scrollViewport={scrollViewport} />}<div className="conversation-stage-content space-y-5"><div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>{virtualItems.map((virtualItem) => {
    if (virtualItem.index === 0) return <div className="absolute left-0 top-0 w-full" data-index={virtualItem.index} key={virtualItem.key} ref={virtualizer.measureElement} style={{ transform: `translateY(${virtualItem.start}px)` }}><HistoryLoadSentinel canLoad={canLoadEarlier} hasEarlier={hasEarlier} isLoading={isLoadingEarlier} key={history?.session.id} onLoad={loadEarlier} requested={historyLoadRequested} scrollViewport={scrollViewport ?? null} /></div>
    const item = items[virtualItem.index - 1]!
    return <div className="absolute left-0 top-0 w-full pb-5" data-index={virtualItem.index} key={virtualItem.key} ref={virtualizer.measureElement} style={{ transform: `translateY(${virtualItem.start}px)` }}><TurnItem isRunning={isRunning && virtualItem.index === items.length} item={item} onFinalAnswerStart={onFinalAnswerStart} onFinalAnswerStream={onFinalAnswerStream} /></div>
  })}</div></div></section>
}

function HistoryLoadSentinel({ canLoad, hasEarlier, isLoading, onLoad, requested, scrollViewport }: { canLoad: boolean; hasEarlier: boolean; isLoading: boolean; onLoad: () => void; requested: { current: boolean }; scrollViewport: HTMLElement | null }) {
  const target = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!canLoad || !hasEarlier || isLoading || !scrollViewport || !target.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !requested.current) {
        requested.current = true
        onLoad()
      }
    }, { root: scrollViewport, rootMargin: '160px 0px 0px', threshold: 0 })
    observer.observe(target.current)
    return () => observer.disconnect()
  }, [canLoad, hasEarlier, isLoading, onLoad, requested, scrollViewport])

  return <div aria-live="polite" className="h-5 text-center text-xs text-muted-foreground" data-history-load-sentinel="" ref={target}>{isLoading ? '正在加载更早历史…' : null}</div>
}

function LoadingTimeline() {
  return <section aria-label="正在加载会话历史" className="space-y-7">{Array.from({ length: 3 }, (_, index) => <Skeleton className="h-20 max-w-2xl" key={index} />)}</section>
}

function HistoryError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="rounded-lg border border-destructive/30 border-l-2 border-l-destructive bg-destructive/5 p-4" role="alert">
      <h2 className="text-sm font-semibold">无法读取会话历史</h2>
      <p className="mt-2 text-sm text-muted-foreground">历史仍保留在本机原生会话中；请刷新后重试。</p>
      <Button className="mt-3" onClick={onRetry} size="sm" type="button" variant="secondary">重试</Button>
    </section>
  )
}

const TurnItem = memo(function TurnItem({ isRunning, item, onFinalAnswerStart, onFinalAnswerStream }: { isRunning: boolean; item: TimelineItem; onFinalAnswerStart: ((turnId: string) => void) | undefined; onFinalAnswerStream: (() => void) | undefined }) {
  const presentation = useMemo(() => projectTurnPresentation(item, isRunning), [item, isRunning])
  return (
    <article className="space-y-3" data-turn-id={item.id}>
      {item.prompt && <UserPrompt prompt={item.prompt} startedAt={item.startedAt} />}
      <TurnExecution isRunning={isRunning} item={item} presentation={presentation} />
      <FinalAnswer isRunning={isRunning} onStart={() => onFinalAnswerStart?.(item.id)} onStream={onFinalAnswerStream} parts={presentation.finalAnswer} turnId={item.id} />
    </article>
  )
})

function FinalAnswer({ isRunning, onStart, onStream, parts, turnId }: { isRunning: boolean; onStart: () => void; onStream: (() => void) | undefined; parts: Extract<TimelineItem['parts'][number], { kind: 'assistant_text' }>[]; turnId: string }) {
  const hadAnswer = useRef(false)
  const previousAnswer = useRef('')
  const answer = parts.map((part) => part.text).join('\n')

  useLayoutEffect(() => {
    if (!answer) {
      hadAnswer.current = false
      previousAnswer.current = ''
      return
    }
    if (!hadAnswer.current) {
      hadAnswer.current = true
      if (isRunning) onStart()
    } else if (isRunning && answer !== previousAnswer.current) onStream?.()
    previousAnswer.current = answer
  }, [answer, isRunning, onStart, onStream])

  return <div className="space-y-3" data-final-answer-turn-id={turnId}>{parts.map((part, index) => <article key={`${part.events[0]?.id ?? index}-${index}`}><AssistantMarkdown isStreaming={isRunning} source={part.text} /></article>)}</div>
}

function UserPrompt({ prompt, startedAt }: { prompt: string; startedAt: string }) {
  const [expanded, setExpanded] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)
  const content = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = content.current
    if (!node) return
    const measure = () => {
      if (!expanded) setHasOverflow(promptOverflows(node.scrollHeight, node.clientHeight))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [expanded, prompt])

  return (
    <div className="ml-auto w-fit max-w-[min(72%,42rem)]">
      <header className="mb-1 truncate text-right text-xs font-medium text-foreground">用户 · <time className="font-normal text-muted-foreground" dateTime={startedAt}>{formatUpdatedAt(startedAt)}</time></header>
      <div className="ml-auto w-fit max-w-full rounded-[10px] bg-muted/75 px-4 py-3">
        <div className={`relative ${expanded ? '' : 'max-h-56 overflow-hidden'}`} ref={content}>
          <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-7">{prompt}</pre>
          {!expanded && hasOverflow && <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-muted to-transparent" />}
        </div>
        {hasOverflow && <Button aria-expanded={expanded} className="mt-1 h-auto px-1 py-1 text-xs" onClick={() => setExpanded(!expanded)} size="sm" type="button" variant="ghost">{expanded ? '收起' : '显示更多'}</Button>}
      </div>
    </div>
  )
}
