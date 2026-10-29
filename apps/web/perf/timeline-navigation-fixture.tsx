import { useCallback, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSessionHistory } from '../src/use-session-history.js'
import { historyCacheVersion, sessionHistoryQueryKey, sessionTurnIndexQueryKey } from '../src/history.js'
import { SessionTimeline } from '../src/session-timeline.js'
import { useTimelineViewport } from '../src/use-timeline-viewport.js'

const entries = Array.from({ length: 500 }, (_, index) => {
  const timestamp = new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString()
  const text = index % 3 ? 'A short reply.' : Array.from({ length: 18 }, (_, line) => `Paragraph ${line + 1}: ${'A longer historical answer. '.repeat(8)}`).join('\n\n')
  return [
    { id: `user-${index + 1}`, parentId: null, type: 'message', timestamp, raw: { type: 'message', message: { role: 'user', content: `Question ${index + 1}` } } },
    { id: `answer-${index + 1}`, parentId: `user-${index + 1}`, type: 'message', timestamp, raw: { type: 'message', message: { role: 'assistant', content: text, stopReason: 'stop' } } },
  ]
}).flat()
const history = { session: { id: 'navigation-fixture' }, revision: 'fixture', hasEarlier: false, entries }

/** Isolated real-layout navigation; no native sessions or model requests. */
export function TimelineNavigationFixture() {
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    cache.setQueryData(sessionHistoryQueryKey(history.session.id), { pages: [history], pageParams: [{}] })
    cache.setQueryData(sessionTurnIndexQueryKey(history.session.id, history.revision), { revision: history.revision, entries: entries.filter((entry) => entry.raw.message.role === 'user').map((entry, index) => ({ id: entry.id, startedAt: entry.timestamp, promptPreview: entry.raw.message.content, index: index + 1 })) })
    for (const turn of [10, 250, 490]) cache.setQueryData(['session-history-page', history.session.id, historyCacheVersion, history.revision, `user-${turn + 1}`], { ...history, entries: entries.slice(Math.max(0, turn - 10) * 2, turn * 2) })
    return cache
  })
  return <QueryClientProvider client={client}><NavigationBody client={client} /></QueryClientProvider>
}

function NavigationBody({ client }: { client: QueryClient }) {
  const session = useSessionHistory(history.session.id, false)
  const { beginTurnNavigation, scrollViewport, setMessageScrollArea, registerTimelineScroll } = useTimelineViewport({ selectedSessionId: history.session.id, history: session.history, activeTurn: undefined, isActive: false, pendingJump: session.pendingJump, onCancelTurnJump: session.cancelTurnJump })
  const { requestTurnJump } = session
  const request = useCallback((turnId: string, cursor?: string, loaded = true) => {
    beginTurnNavigation()
    return requestTurnJump(turnId, cursor, loaded)
  }, [beginTurnNavigation, requestTurnJump])
  const [trace, setTrace] = useState('')
  const [traceTarget, setTraceTarget] = useState<{ turn: number }>()
  useEffect(() => {
    if (!traceTarget || !scrollViewport) return
    let frame: number
    const samples: { top: number; targetTop: number | null }[] = []
    const sample = () => {
      const row = scrollViewport.querySelector<HTMLElement>(`[data-turn-id="user-${traceTarget.turn}"]`)
      samples.push({ top: scrollViewport.scrollTop, targetTop: row ? row.getBoundingClientRect().top - scrollViewport.getBoundingClientRect().top : null })
      if (samples.length < 90) frame = requestAnimationFrame(sample)
      else setTrace(JSON.stringify({ target: traceTarget.turn, samples: samples.filter((value, i) => i === 0 || i === samples.length - 1 || value.top !== samples[i - 1]!.top) }))
    }
    frame = requestAnimationFrame(sample)
    return () => cancelAnimationFrame(frame)
  }, [traceTarget, scrollViewport])
  function choose(turn: number) {
    setTraceTarget({ turn })
    void request(`user-${turn}`, `user-${turn + 1}`, Boolean(session.history?.entries.some((entry) => entry.id === `user-${turn}`)))
  }
  const [release, setRelease] = useState<(() => void)>()
  function delayJump() {
    const queryKey = ['session-history-page', history.session.id, historyCacheVersion, history.revision, 'user-11']
    client.removeQueries({ queryKey, exact: true })
    void client.fetchQuery({ queryKey, staleTime: Infinity, queryFn: () => new Promise((resolve) => {
      setRelease(() => () => { resolve({ ...history, entries: entries.slice(0, 20) }); setRelease(undefined) })
    }) })
    choose(10)
  }
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div className="flex gap-4 p-3">{[10, 250, 490].map((turn) => <button key={turn} onClick={() => choose(turn)}>跳到第 {turn} 轮</button>)}<button onClick={() => client.setQueryData(sessionHistoryQueryKey(history.session.id), { pages: [{ ...history, hasEarlier: true, beforeCursor: 'user-461', entries: entries.slice(-80) }], pageParams: [{}] })}>仅保留最近40轮</button><button onClick={delayJump}>延迟载入第10轮</button>{release && <button onClick={release}>完成延迟请求</button>}</div>
    <output aria-label="导航状态">{JSON.stringify({ pending: session.pendingJump, error: session.jumpError, count: session.history?.entries.length })}</output>
    <output aria-label="导航轨迹" className="h-16 shrink-0 overflow-auto text-xs">{trace}</output>
    <div ref={setMessageScrollArea} style={{ minHeight: 0, flex: 1 }}>
      <div data-slot="scroll-area-viewport" tabIndex={0} style={{ height: '100%', overflow: 'auto' }}>
        <SessionTimeline history={session.history} error={false} isLoading={false} onRetry={() => {}} overlayRoot={null} scrollViewport={scrollViewport} registerTimelineScroll={registerTimelineScroll} onRequestTurnJump={request} pendingJump={session.pendingJump} onTurnJumpFinished={session.finishTurnJump} jumpError={session.jumpError} />
      </div>
    </div>
  </div>
}
