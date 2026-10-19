// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TurnFileSummary } from './turn-file-summary.js'
import { useTimelineViewport } from './use-timeline-viewport.js'

it.each([
  { cached: true, input: 'wheel' },
  { cached: false, input: 'wheel' },
  { cached: false, input: 'touchstart' },
  { cached: false, input: 'keydown' },
  { cached: false, input: 'pointerdown' },
])('positions history at the bottom and lets $input interrupt (cached: $cached)', async ({ cached, input }) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const observers = new Set<() => void>()
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe() { observers.add(this.callback) }
    disconnect() { observers.delete(this.callback) }
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let height = cached ? 1000 : 500
  let top = 0
  let followingLatest = true
  function View({ sessionId, loaded = true, completed = false }: { sessionId: string; loaded?: boolean; completed?: boolean }) {
    const { setMessageScrollArea, followLatest } = useTimelineViewport({ selectedSessionId: sessionId, history: loaded ? { session: { id: sessionId }, entries: [], hasEarlier: false, revision: 'fixture' } : undefined, activeTurn: undefined, isActive: false })
    useLayoutEffect(() => { followingLatest = followLatest })
    return <div ref={setMessageScrollArea}><div data-slot="scroll-area-viewport">{completed && <TurnFileSummary state="complete" files={[{ path: '/project/a.ts', displayPath: 'a.ts', outsideProject: false, operations: [], reported: true, status: '已修改' }]} />}</div></div>
  }
  const flush = async () => {
    await act(() => {
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((callback) => callback(0))
    })
  }
  const resize = async () => { await act(() => observers.forEach((callback) => callback())) }
  try {
    await act(() => root.render(<View sessionId="A" loaded={cached} />))
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => height },
      clientHeight: { get: () => 500 },
      scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(height - 500, value)) } },
    })
    viewport.scrollTo = (options) => { viewport.scrollTop = (options as ScrollToOptions).top ?? top }
    await flush()
    if (!cached) {
      height = 1000
      await act(() => root.render(<View sessionId="A" />))
    }
    await act(() => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })))
    for (let measurement = 0; measurement < 3; measurement++) {
      height += 400
      await resize()
      await act(() => viewport.dispatchEvent(new Event('scroll')))
      await flush()
      expect(top).toBe(height - 500)
      expect(followingLatest).toBe(true)
    }

    for (const sessionId of ['B', 'A']) {
      height += 1000
      await act(() => root.render(<View sessionId={sessionId} />))
      await resize()
      // Browsers can emit a scroll event before the queued follow frame runs.
      await act(() => viewport.dispatchEvent(new Event('scroll')))
      await flush()
      expect(top).toBe(height - 500)
      height += 400
      await resize()
      await flush()
      expect(top).toBe(height - 500)
      expect(followingLatest).toBe(true)
    }

    height += 400
    await resize()
    await act(() => viewport.dispatchEvent(input === 'keydown' ? new KeyboardEvent('keydown', { key: 'PageUp' }) : new Event(input)))
    top = 100
    await act(() => viewport.dispatchEvent(new Event('scroll')))
    height += 400
    await resize()
    await flush()
    expect(top).toBe(100)
    expect(followingLatest).toBe(false)

    await act(() => root.render(<View sessionId="B" />))
    await flush()
    height += 400
    await resize()
    await flush()
    expect(top).toBe(height - 500)
    expect(followingLatest).toBe(true)

    // The completed summary follows only while the reader is still following the bottom.
    height += 400
    await act(() => root.render(<View sessionId="B" completed />))
    await resize()
    await flush()
    expect(top).toBe(height - 500)
    await act(() => viewport.querySelector<HTMLElement>('[data-turn-file-summary]')!.click())
    const readingTop = top
    height += 400
    await resize()
    await flush()
    expect(top).toBe(readingTop)
    expect(followingLatest).toBe(false)
  } finally {
    await act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
