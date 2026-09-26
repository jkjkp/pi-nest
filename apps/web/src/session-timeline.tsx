import { useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

import { AssistantMarkdown } from './assistant-markdown.js'
import type { PiSessionHistoryResponse } from './history.js'
import { timelineItems, timelineNavigationEntries, type RuntimeTurn, type TimelineItem } from './timeline-model.js'
import type { PiRuntimeEvent } from './runtime-websocket-client.js'
import { TurnNavigationRail } from './turn-navigation-rail.js'
import { TurnExecution } from './turn-execution.js'
import { projectTurnPresentation } from './turn-execution-model.js'
import { promptOverflows } from './user-prompt-state.js'
import { formatUpdatedAt } from './workspace.js'

export function SessionTimeline({ error, history, isLoading, isRunning = false, onFinalAnswerStart, onFinalAnswerStream, onJumpToTurn, onRetry, overlayRoot, scrollViewport, systemEvents = [], turns = [] }: {
  error: boolean
  history: PiSessionHistoryResponse | undefined
  isLoading: boolean
  isRunning?: boolean
  onFinalAnswerStart?: (turnId: string) => void
  onFinalAnswerStream?: () => void
  onJumpToTurn?: (turnId: string) => void
  onRetry: () => void
  overlayRoot?: HTMLElement | null
  scrollViewport?: HTMLElement | null
  systemEvents?: PiRuntimeEvent[]
  turns?: RuntimeTurn[]
}) {
  const timelineRoot = useRef<HTMLElement>(null)
  if (isLoading) return <LoadingTimeline />
  if (error) return <HistoryError onRetry={onRetry} />

  const items = timelineItems(history?.entries, turns, systemEvents)
  if (items.length === 0) {
    return <section className="py-8 text-center"><p className="text-sm text-muted-foreground">{isRunning ? '正在等待 Pi 原生事件…' : '当前活动分支尚无可展示的原生条目。'}</p></section>
  }

  const navigationEntries = timelineNavigationEntries(items)
  const jump = onJumpToTurn ?? (() => undefined)
  return <section className="conversation-stage pb-6" ref={timelineRoot}>{overlayRoot !== null && <TurnNavigationRail entries={navigationEntries} onJump={jump} overlayRoot={overlayRoot} scrollViewport={scrollViewport ?? null} timelineRoot={timelineRoot} />}<div className="conversation-stage-content space-y-5">{history?.hasEarlier && <p className="rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">当前仅展示最近 200 条原生条目。</p>}{items.map((item, index) => <TurnItem isRunning={isRunning && index === items.length - 1} item={item} key={item.id} onFinalAnswerStart={onFinalAnswerStart} onFinalAnswerStream={onFinalAnswerStream} />)}</div></section>
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

function TurnItem({ isRunning, item, onFinalAnswerStart, onFinalAnswerStream }: { isRunning: boolean; item: TimelineItem; onFinalAnswerStart: ((turnId: string) => void) | undefined; onFinalAnswerStream: (() => void) | undefined }) {
  const presentation = projectTurnPresentation(item, isRunning)
  return (
    <article className="space-y-3" data-turn-id={item.id}>
      {item.prompt && <UserPrompt prompt={item.prompt} startedAt={item.startedAt} />}
      <TurnExecution isRunning={isRunning} item={item} presentation={presentation} />
      <FinalAnswer isRunning={isRunning} onStart={() => onFinalAnswerStart?.(item.id)} onStream={onFinalAnswerStream} parts={presentation.finalAnswer} turnId={item.id} />
    </article>
  )
}

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
