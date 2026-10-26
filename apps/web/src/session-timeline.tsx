import { AnswerActions } from './answer-actions.js'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { MessageAttachments } from './attachment-ui.js'
import { ModelCallErrorNotice } from './model-call-error-notice.js'
import { RenderErrorBoundary } from './render-error-boundary.js'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

import { AssistantMarkdown } from './assistant-markdown.js'
import { historyPageCursorForTurn, type PiSessionHistoryResponse, type PiSessionTurnIndex } from './history.js'
import type { TimelineScrollController, TurnJumpAlignment } from './timeline-pagination.js'
import { timelineNavigationTurns } from './timeline-navigation.js'
import { timelineItems, type RuntimeTurn, type TimelineItem } from './timeline-model.js'
import type { PiRuntimeEvent } from './runtime-websocket-client.js'
import { TurnNavigationRail } from './turn-navigation-rail.js'
import { TurnExecution } from './turn-execution.js'
import { TurnFileSummary } from './turn-file-summary.js'
import { projectTurnFiles, turnFileSummaryState, projectTurnPresentation } from './turn-execution-model.js'
import { promptOverflows } from './user-prompt-state.js'
import { formatUpdatedAt } from './workspace.js'
import type { PendingInput, PromptStatus } from './session-run-model.js'

export function SessionTimeline({ error, hasEarlier = false, history, isLoading, isLoadingEarlier = false, isRunning = false, onFinalAnswerStart, onFinalAnswerStream, onRetrySteering, onJumpToTurn, onJumpToUnloadedTurn, onReadTurnPrompt, onLoadEarlier, onPendingJumpHandled, onRetry, onRetryNavigation, onBranchAnswer, branchDisabled = false, navigationNotice, overlayRoot, pendingInputs = [], pendingJumpTurnId, runMessage, runStatus, sessionId, sessionCwd, scrollViewport, registerTimelineScroll, systemEvents = [], turnIndex, turns = [] }: {
  error: boolean
  hasEarlier?: boolean
  history: PiSessionHistoryResponse | undefined
  isLoading: boolean
  isLoadingEarlier?: boolean
  isRunning?: boolean
  onFinalAnswerStart?: (turnId: string) => void
  onRetrySteering?: (turnId: string) => void
  onFinalAnswerStream?: () => void
  onJumpToTurn?: (turnId: string, scrollTo: (behavior: ScrollBehavior) => void, alignment: TurnJumpAlignment) => void
  onJumpToUnloadedTurn?: (turnId: string, cursor: string | undefined) => void | Promise<void>
  onReadTurnPrompt?: (turnId: string, cursor: string | undefined) => Promise<string>
  onLoadEarlier?: () => void
  onPendingJumpHandled?: () => void
  onRetry: () => void
  onBranchAnswer?: (entryId: string, revision: string) => Promise<void>
  branchDisabled?: boolean
  onRetryNavigation?: () => void
  navigationNotice?: string
  overlayRoot?: HTMLElement | null
  pendingInputs?: PendingInput[]
  pendingJumpTurnId?: string
  runMessage?: string
  runStatus?: PromptStatus
  sessionId?: string
  sessionCwd?: string
  scrollViewport?: HTMLElement | null
  registerTimelineScroll?: (controller: TimelineScrollController | null) => void
  systemEvents?: PiRuntimeEvent[]
  turnIndex?: PiSessionTurnIndex
  turns?: RuntimeTurn[]
}) {
  const historyLoadRequested = useRef(false)
  const [canLoadEarlier, setCanLoadEarlier] = useState(false)
  const items = useMemo(() => timelineItems(history?.entries, turns, systemEvents), [history?.entries, systemEvents, turns])
  const activeExecutionItem = items.findLast((item) => !item.steering || item.steering.status === 'applied')
  const persistedIndex = turnIndex && turnIndex.revision === history?.revision ? turnIndex.entries : undefined
  const railEntries = useMemo(() => timelineNavigationTurns(persistedIndex, items), [items, persistedIndex])
  // oxlint-disable-next-line react/incompatible-library -- The virtualizer owns DOM measurement state outside React.
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 240,
    getItemKey: (index) => items[index]!.displayId ?? items[index]!.id,
    paddingStart: 20,
    // Preserve the current message and offset when older pages arrive during streaming.
    anchorTo: 'end',
    // Disable virtualizer bottom following; useTimelineViewport owns the reader's pause.
    scrollEndThreshold: -1,
    getScrollElement: () => scrollViewport ?? null,
    initialRect: { height: 800, width: 0 },
    overscan: 8,
    // Keep size corrections and item positions in one paint without re-entering React.
    directDomUpdates: true,
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: true,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const activeVirtualItem = virtualizer.getVirtualItemForOffset((virtualizer.scrollOffset ?? 0) + 48)
  const activeTurnId = items[activeVirtualItem?.index ?? 0]?.id
  useLayoutEffect(() => {
    if (!registerTimelineScroll || !scrollViewport || !history) return
    registerTimelineScroll({
      sessionId: history.session.id,
      capture: () => {
        const top = scrollViewport.getBoundingClientRect().top
        const turn = [...scrollViewport.querySelectorAll<HTMLElement>('[data-turn-id]')].find((node) => node.getBoundingClientRect().bottom > top + 48)
        return { turnId: turn?.dataset.turnId, offset: turn ? turn.getBoundingClientRect().top - top : 0, scrollTop: scrollViewport.scrollTop }
      },
      restore: (position) => {
        if (!position.turnId) {
          scrollViewport.scrollTo({ top: position.scrollTop, behavior: 'instant' })
          return 'restored'
        }
        const index = items.findIndex((item) => item.id === position.turnId)
        if (index < 0) return 'missing'
        const turn = [...scrollViewport.querySelectorAll<HTMLElement>('[data-turn-id]')].find((node) => node.dataset.turnId === position.turnId)
        if (!turn) {
          virtualizer.scrollToIndex(index, { align: 'start', behavior: 'auto' })
          return 'pending'
        }
        const delta = turn.getBoundingClientRect().top - scrollViewport.getBoundingClientRect().top - position.offset
        if (Math.abs(delta) > 1) scrollViewport.scrollTo({ top: scrollViewport.scrollTop + delta, behavior: 'instant' })
        return 'restored'
      },
    })
    return () => registerTimelineScroll(null)
  }, [history, items, registerTimelineScroll, scrollViewport, virtualizer])
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
    onLoadEarlier()
  }, [hasEarlier, isLoadingEarlier, onLoadEarlier])

  useLayoutEffect(() => {
    if (!pendingJumpTurnId) return
    const index = items.findIndex((item) => item.id === pendingJumpTurnId)
    if (index < 0) return
    const alignment = 'start' as const
    const scrollTo = (behavior: ScrollBehavior) => virtualizer.scrollToIndex(index, { align: alignment, behavior })
    if (onJumpToTurn) onJumpToTurn(pendingJumpTurnId, scrollTo, alignment)
    else scrollTo('auto')
    onPendingJumpHandled?.()
  }, [items, onJumpToTurn, onPendingJumpHandled, pendingJumpTurnId, railEntries, virtualizer])

  const readPrompt = useCallback(async (entry: import('./history.js').TurnIndexEntry) => {
    const loaded = items.find((item) => item.id === entry.id)?.prompt
    if (loaded !== undefined) return loaded
    if (!onReadTurnPrompt) throw new Error('无法读取完整消息。')
    return onReadTurnPrompt(entry.id, historyPageCursorForTurn(railEntries, entry.id))
  }, [items, onReadTurnPrompt, railEntries])

  if (isLoading && items.length === 0) return <LoadingTimeline />
  if (error && items.length === 0) return <HistoryError onRetry={onRetry} />

  const pendingImplementation = pendingInputs.filter((input) => input.mode === 'plan_implementation')
  if (items.length === 0 && pendingImplementation.length === 0) {
    return <section className="py-8 text-center"><p className="text-sm text-muted-foreground">{isRunning ? '正在等待 Pi 原生事件…' : '当前活动分支尚无可展示的原生条目。'}</p></section>
  }


  const jump = (turnId: string) => {
    const index = items.findIndex((item) => item.id === turnId)
    if (index < 0) return onJumpToUnloadedTurn?.(turnId, historyPageCursorForTurn(railEntries, turnId))
    const alignment = 'start' as const
    const scrollTo = (behavior: ScrollBehavior) => virtualizer.scrollToIndex(index, { align: alignment, behavior })
    if (onJumpToTurn) onJumpToTurn(turnId, scrollTo, alignment)
    else scrollTo('auto')
  }
  return <section className="conversation-stage pb-6">{navigationNotice && <div className="conversation-stage-content mb-2 flex items-center justify-end gap-2 text-xs text-muted-foreground" role="status"><span>{navigationNotice}</span><Button onClick={onRetryNavigation} size="sm" variant="ghost" type="button">重试</Button></div>}{error && <HistoryError onRetry={onRetry} />}{overlayRoot !== null && <TurnNavigationRail key={history?.session.id} onReadPrompt={readPrompt} activeTurnId={activeTurnId} entries={railEntries} onJump={jump} overlayRoot={overlayRoot} />}<div className="conversation-stage-content space-y-5"><div className="relative w-full" ref={virtualizer.containerRef}><div className="absolute left-0 top-0 w-full"><HistoryLoadSentinel canLoad={canLoadEarlier} hasEarlier={hasEarlier} isLoading={isLoadingEarlier} key={history?.session.id} onLoad={loadEarlier} requested={historyLoadRequested} scrollViewport={scrollViewport ?? null} /></div>{virtualItems.map((virtualItem) => {
    const item = items[virtualItem.index]!
    return <div className="absolute left-0 top-0 w-full pb-5" data-index={virtualItem.index} key={virtualItem.key} ref={virtualizer.measureElement}><RenderErrorBoundary scope="turn" sessionId={history?.session.id} turnId={item.id}><TurnItem onBranchAnswer={onBranchAnswer} branchDisabled={branchDisabled || isRunning} revision={history?.revision} sessionId={sessionId ?? history?.session.id} cwd={sessionCwd ?? history?.session.cwd} hasFollowingTurn={item !== activeExecutionItem} onRetrySteering={onRetrySteering} canRetrySteering={isRunning} isRunning={isRunning && item === activeExecutionItem} item={item} onFinalAnswerStart={onFinalAnswerStart} onFinalAnswerStream={onFinalAnswerStream} runMessage={item === activeExecutionItem ? runMessage : undefined} runStatus={item === activeExecutionItem ? runStatus : undefined} /></RenderErrorBoundary></div>
  })}</div>{pendingImplementation.map((input) => <PendingUserInput input={input} key={input.id} />)}</div></section>
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
      <h2 className="text-sm font-normal">无法读取会话历史</h2>
      <p className="mt-2 text-sm text-muted-foreground">历史仍保留在本机原生会话中；请刷新后重试。</p>
      <Button className="mt-3" onClick={onRetry} size="sm" type="button" variant="secondary">重试</Button>
    </section>
  )
}

const TurnItem = memo(function TurnItem({ onBranchAnswer, branchDisabled, revision, sessionId, isRunning, item, cwd, hasFollowingTurn, onFinalAnswerStart, onFinalAnswerStream, onRetrySteering, canRetrySteering, runMessage, runStatus }: { onBranchAnswer?: (entryId: string, revision: string) => Promise<void>; branchDisabled: boolean; revision?: string; sessionId?: string; cwd?: string; hasFollowingTurn: boolean; onRetrySteering?: (turnId: string) => void; canRetrySteering: boolean; isRunning: boolean; item: TimelineItem; onFinalAnswerStart: ((turnId: string) => void) | undefined; onFinalAnswerStream: (() => void) | undefined; runMessage: string | undefined; runStatus: PromptStatus | undefined }) {
  const presentation = useMemo(() => projectTurnPresentation(item, isRunning), [item, isRunning])
  const files = useMemo(() => projectTurnFiles(presentation.activities, cwd), [presentation.activities, cwd])
  const branchEntry = presentation.finalAnswer.flatMap((part) => part.events).findLast((event) => event.event.type === 'message' && (event.event.message as { role?: string } | undefined)?.role === 'assistant')
  const summaryState = turnFileSummaryState(item, isRunning, runStatus, hasFollowingTurn)
  return (
    <article className="space-y-3" data-turn-id={item.id}>
      {sessionId && !!item.attachments?.length && <div className="ml-auto w-fit max-w-full"><MessageAttachments attachments={item.attachments} scope={{ kind: 'session', sessionId }} /></div>}
      {item.attachmentWarning && <p role="alert" className="text-xs text-destructive">{item.attachmentWarning}</p>}
      {item.prompt && <UserPrompt prompt={item.prompt} startedAt={item.startedAt} />}
      {item.steering && item.steering.status !== 'applied' ? <div aria-live="polite" className="flex items-center justify-end gap-2 text-xs text-muted-foreground"><span className={item.steering.status === 'failed' ? 'text-destructive' : undefined}>{item.steering.status === 'sending' ? '发送中…' : item.steering.status === 'accepted' ? '引导已发送' : item.steering.status === 'unknown' ? '正在确认发送状态，请勿重复发送' : `发送失败：${item.steering.error ?? '请重试'}`}</span>{item.steering.status === 'failed' && onRetrySteering && <Button disabled={!canRetrySteering} onClick={() => onRetrySteering(item.id)} type="button" size="sm" variant="ghost">重试</Button>}</div> : <TurnExecution files={files} showFileProgress={!summaryState} isRunning={isRunning} item={item} presentation={presentation} runMessage={runMessage} runStatus={runStatus} />}
      {item.modelErrors?.map((error, index) => <ModelCallErrorNotice error={error} key={index} />)}
      {item.plan && <section aria-label="计划正文" id={`plan-${item.id}`} className="rounded-lg border bg-card p-4"><h2 className="mb-3 text-sm font-normal">计划已制定</h2><AssistantMarkdown source={item.plan.text} isStreaming={false} /></section>}
      <FinalAnswer onBranch={!branchDisabled && branchEntry && revision && onBranchAnswer ? () => onBranchAnswer(branchEntry.id, revision) : undefined} isRunning={isRunning} onStart={() => onFinalAnswerStart?.(item.id)} onStream={onFinalAnswerStream} parts={presentation.finalAnswer} turnId={item.id} />
      {summaryState && files.length > 0 && <TurnFileSummary files={files} state={summaryState} />}
    </article>
  )
})

function FinalAnswer({ onBranch, isRunning, onStart, onStream, parts, turnId }: { onBranch?: () => Promise<void>; isRunning: boolean; onStart: () => void; onStream: (() => void) | undefined; parts: Extract<TimelineItem['parts'][number], { kind: 'assistant_text' }>[]; turnId: string }) {
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

  // Part order survives history handoff; transport event IDs do not.
  return <div className="space-y-3" data-final-answer-turn-id={turnId}>{parts.map((part, index) => <article key={index}><AssistantMarkdown isStreaming={isRunning} source={part.text} /></article>)}{!isRunning && answer.trim() && <AnswerActions text={answer} onBranch={onBranch} />}</div>
}

function UserPrompt({ prompt, startedAt }: { prompt: string; startedAt: string }) {
  const [expanded, setExpanded] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [touchRevealed, setTouchRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copyError, setCopyError] = useState<string>()
  const copyingRef = useRef(false)
  const content = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timeout)
  }, [copied])

  async function copyPrompt() {
    if (copyingRef.current) return
    copyingRef.current = true
    setCopying(true)
    setCopyError(undefined)
    setCopied(false)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入。')
      try { await navigator.clipboard.writeText(prompt) }
      catch { throw new Error('复制失败，请检查浏览器剪贴板权限后重试。') }
      setCopied(true)
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : '复制失败，请重试。')
    } finally {
      copyingRef.current = false
      setCopying(false)
    }
  }

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
    <div className="user-prompt ml-auto w-fit max-w-[min(72%,42rem)] rounded-[10px] focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} aria-label="用户消息" data-touch-revealed={touchRevealed} onPointerDown={(event) => {
      if (event.pointerType === 'touch' && !(event.target as HTMLElement).closest('button')) setTouchRevealed((value) => !value)
    }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setTouchRevealed(false) }}>
      <div className="ml-auto w-fit max-w-full rounded-[10px] bg-[var(--user-prompt-background)] px-4 py-3 text-[var(--user-prompt-foreground)]">
        <div className={`relative ${expanded ? '' : 'max-h-56 overflow-hidden'}`} ref={content}>
          <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-[26px]">{prompt}</pre>
          {!expanded && hasOverflow && <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--user-prompt-background)] to-transparent" />}
        </div>
        {hasOverflow && <Button aria-expanded={expanded} className="mt-1.5 min-h-7 h-auto rounded-sm border-0 bg-transparent px-0 py-1 text-inherit opacity-80 shadow-none underline-offset-4 hover:bg-transparent hover:text-inherit hover:opacity-100 hover:underline aria-expanded:bg-transparent aria-expanded:text-inherit focus-visible:ring-1 focus-visible:ring-white/60 dark:hover:bg-transparent" onClick={() => setExpanded(!expanded)} size="sm" type="button" variant="ghost"><span className="inline-flex items-center gap-1 text-xs">{expanded ? '收起' : '显示更多'}<ChevronDown aria-hidden="true" className={`size-[1em] ${expanded ? 'rotate-180' : ''}`} /></span></Button>}
      </div>
      <div className="user-prompt-actions flex h-8 items-center justify-end gap-2 text-[15px] text-muted-foreground" role="group" aria-label="用户消息操作">
        <time className="truncate text-xs" dateTime={startedAt}>{formatUpdatedAt(startedAt)}</time>
        <Button type="button" variant="ghost" size="icon-sm" className="border-0 text-[length:inherit] hover:bg-transparent dark:hover:bg-transparent" aria-label={copied ? '已复制' : '复制消息'} title={copied ? '已复制' : '复制消息'} disabled={copying} onClick={() => void copyPrompt()}>{copied ? <Check aria-hidden="true" className="size-[1em]" /> : <Copy aria-hidden="true" className="size-[1em]" />}</Button>
      </div>
      {copyError && <p role="alert" className="text-right text-xs text-destructive">{copyError}</p>}
    </div>
  )
}

function PendingUserInput({ input }: { input: PendingInput }) {
  return <div className="ml-auto w-fit max-w-[min(72%,42rem)]" data-pending-input={input.id}>
    <UserPrompt prompt={input.message} startedAt={input.submittedAt} />
    <p className="mt-1 text-right text-xs text-muted-foreground">已发送 · {input.mode === 'steer' ? 'Steer' : input.mode === 'plan_implementation' ? 'Implement' : 'Follow-up'}</p>
  </div>
}
