// @vitest-environment happy-dom
import { act, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionTimeline } from './session-timeline.js'
import { useTimelineViewport } from './use-timeline-viewport.js'
import { useSessionHistory } from './use-session-history.js'
import { sessionHistoryQueryKey } from './history.js'
import { fetchSessionHistory } from './workspace-api.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), fetchSessionHistory: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function setup() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  const entries = Array.from({ length: 80 }, (_, i) => ({ id: `turn-${i}`, parentId: null, type: 'message', timestamp: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), raw: { type: 'message', message: { role: 'user', content: `Question ${i}` } } }))
  const history = { session: { id: 'one' }, revision: 'fixture', hasEarlier: false, entries }
  client.setQueryData(sessionHistoryQueryKey('one'), { pages: [history], pageParams: [{}] })
  client.setQueryData(sessionHistoryQueryKey('two'), { pages: [{ ...history, session: { id: 'two' } }], pageParams: [{}] })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let top = 0
  let probe!: { session: ReturnType<typeof useSessionHistory>; view: ReturnType<typeof useTimelineViewport>; selectSession: (id: string) => void }
  const writes: ScrollToOptions[] = []
  const heights = Array.from({ length: 80 }, (_, i) => i % 3 ? 120 : 2400)
  const rect = (node: HTMLElement): DOMRect => {
    const row = node.hasAttribute('data-index') ? node : node.closest<HTMLElement>('[data-index]')
    const index = Number(row?.dataset.index)
    const y = row ? Number(row.style.transform.match(/translate(?:Y|3d)\((?:0, )?(-?[\d.]+)px/)?.[1] ?? 0) - top : 0
    return { top: y, bottom: y + (row ? heights[index]! : 500), height: row ? heights[index]! : 500, width: 800, left: 0, right: 800, x: 0, y, toJSON() {} }
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return rect(this) })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-index') ? heights[Number(this.dataset.index)]! : 500 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  function View() {
    const [sessionId, selectSession] = useState('one')
    const session = useSessionHistory(sessionId, false)
    const view = useTimelineViewport({ selectedSessionId: sessionId, history: session.history, activeTurn: undefined, isActive: false, pendingJump: session.pendingJump, onCancelTurnJump: session.cancelTurnJump })
    useLayoutEffect(() => { probe = { session, view, selectSession } }, [session, view, selectSession])
    return <div ref={(node) => {
      const viewport = node?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
      if (viewport) {
        Object.defineProperties(viewport, {
          scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(viewport.scrollHeight - 500, value)) } },
          scrollHeight: { configurable: true, get: () => Number.parseFloat(viewport.querySelector<HTMLElement>('[data-index]')?.parentElement?.style.height ?? '0') + 100 },
          clientHeight: { configurable: true, get: () => 500 },
        })
        viewport.scrollTo = (options) => { writes.push(options as ScrollToOptions); viewport.scrollTop = (options as ScrollToOptions).top ?? top; viewport.dispatchEvent(new Event('scroll')) }
      }
      view.setMessageScrollArea(node)
    }}><div data-slot="scroll-area-viewport"><SessionTimeline key={sessionId} history={session.history} error={false} isLoading={false} onRetry={() => {}} overlayRoot={null} pendingJump={session.pendingJump} onTurnJumpFinished={session.finishTurnJump} scrollViewport={view.scrollViewport} registerTimelineScroll={view.registerTimelineScroll} /></div></div>
  }
  await act(() => root.render(<QueryClientProvider client={client}><View /></QueryClientProvider>))
  const flush = async () => { for (let i = 0; i < 20 && frames.size; i++) await act(() => { const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(0)) }) }
  await flush()
  return {
    get probe() { return probe }, client, history, heights, container, writes, frames, flush,
    async jump(id: string, loaded = true) { await act(async () => { probe.view.beginTurnNavigation(); await probe.session.requestTurnJump(id, undefined, loaded) }) },
    async cleanup() { await act(() => root.unmount()); client.clear(); container.remove() },
  }
}

it('lands large jumps against real virtualizer measurements, without smooth scrolling', async () => {
  const test = await setup()
  try {
    for (const target of ['turn-10', 'turn-65', 'turn-20']) {
      await test.jump(target); await test.flush()
      expect(test.probe.session.pendingJump).toBeUndefined()
      expect(test.probe.view.showScrollToBottom).toBe(true)
      const row = test.container.querySelector<HTMLElement>(`[data-turn-id="${target}"]`)!
      expect(Math.abs(row.getBoundingClientRect().top - 48)).toBeLessThanOrEqual(2)
    }
    expect(test.writes.every((write) => write.behavior !== 'smooth')).toBe(true)
  } finally { await test.cleanup() }
})

it('reconciles a late size change before reporting the target as settled', async () => {
  const test = await setup()
  try {
    await test.jump('turn-10')
    test.heights[9]! += 800
    await test.flush()
    expect(test.probe.session.pendingJump).toBeUndefined()
    expect(test.container.querySelector<HTMLElement>('[data-turn-id="turn-10"]')!.getBoundingClientRect().top).toBe(48)
  } finally { await test.cleanup() }
})

it('disposes an in-flight positioning task when switching sessions', async () => {
  const test = await setup()
  try {
    await test.jump('turn-10')
    await act(() => test.probe.selectSession('two'))
    await test.flush()
    expect(test.probe.session.history?.session.id).toBe('two')
    expect(test.probe.session.pendingJump).toBeUndefined()
    expect(test.probe.session.jumpError).toBeUndefined()
  } finally { await test.cleanup() }
})

it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])('cancels a locating task on %s, and does not let an old completion clear a new task', async (type) => {
  const test = await setup()
  try {
    await test.jump('turn-10')
    const old = test.probe.session.pendingJump!.id
    await act(() => test.probe.view.scrollViewport!.dispatchEvent(type === 'keydown' ? new KeyboardEvent(type, { key: 'PageUp' }) : new Event(type)))
    await test.flush()
    expect(test.probe.session.pendingJump).toBeUndefined()
    await test.jump('turn-65')
    await act(() => test.probe.session.finishTurnJump(old))
    expect(test.probe.session.pendingJump?.turnId).toBe('turn-65')
    await test.flush()
    expect(test.probe.session.pendingJump).toBeUndefined()
  } finally { await test.cleanup() }
})

it.each(['latest', 'bottom'])('explicit %s following cancels a pending jump', async (action) => {
  const test = await setup()
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  try {
    await test.jump('turn-10')
    await act(() => action === 'latest' ? test.probe.view.setFollowingLatest(true) : test.probe.view.scrollToBottom())
    expect(test.probe.session.pendingJump).toBeUndefined()
    await test.flush()
    expect(test.probe.session.pendingJump).toBeUndefined()
  } finally { await test.cleanup() }
})

it('clamps navigation at the beginning and end without endless corrections', async () => {
  const test = await setup()
  try {
    await test.jump('turn-0'); await test.flush()
    expect(test.probe.session.pendingJump).toBeUndefined()
    expect(test.probe.view.scrollViewport!.scrollTop).toBe(0)
    await test.jump('turn-79'); await test.flush()
    expect(test.probe.session.pendingJump).toBeUndefined()
    const viewport = test.probe.view.scrollViewport!
    expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight)
  } finally { await test.cleanup() }
})

it('invalidates a loading task on revision change without letting its late response take over', async () => {
  const test = await setup()
  try {
    let release!: (page: typeof test.history) => void
    vi.mocked(fetchSessionHistory).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    let request!: Promise<void>
    await act(() => { test.probe.view.beginTurnNavigation(); request = test.probe.session.requestTurnJump('turn-0', undefined, false) })
    await act(() => test.client.setQueryData(sessionHistoryQueryKey('one'), { pages: [{ ...test.history, revision: 'new' }], pageParams: [{}] }))
    await act(async () => { release(test.history); await request })
    expect(test.client.getQueryData<{ pages: typeof test.history[] }>(sessionHistoryQueryKey('one'))?.pages[0]?.revision).toBe('new')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(test.probe.session.pendingJump).toBeUndefined()
  } finally { await test.cleanup() }
})

it('bounds geometric correction and reports an unsettled landing instead of keeping the reader locked', async () => {
  const test = await setup()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    await test.jump('turn-10')
    clock.mockReturnValue(1001)
    await test.flush()
    expect(test.probe.session.pendingJump).toBeUndefined()
    expect(test.probe.session.jumpError).toContain('未能稳定定位')
  } finally { await test.cleanup() }
})

it('preserves existing history on read failure and permits a new selection to retry', async () => {
  const test = await setup()
  try {
    vi.mocked(fetchSessionHistory).mockRejectedValueOnce(new Error('offline'))
    await test.jump('missing', false)
    expect(test.probe.session.history?.entries).toHaveLength(80)
    expect(test.probe.session.pendingJump).toBeUndefined()
    expect(test.probe.session.jumpError).toBe('offline')
    await test.jump('turn-10'); await test.flush()
    expect(test.probe.session.jumpError).toBeUndefined()
  } finally { await test.cleanup() }
})
