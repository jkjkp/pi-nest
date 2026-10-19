// @vitest-environment happy-dom
import { act, useCallback, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SessionTimeline } from './session-timeline.js'
import { useTimelineViewport } from './use-timeline-viewport.js'

const virtual = vi.hoisted(() => ({ hiddenIndex: -1, scrollToIndex: vi.fn() }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; getItemKey: (index: number) => string }) => ({
    getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: index * 240, size: 240 })).filter((item) => item.index !== virtual.hiddenIndex),
    getVirtualItemForOffset: () => ({ index: 1 }),
    getTotalSize: () => options.count * 240,
    measureElement: () => {},
    scrollToIndex: virtual.scrollToIndex,
  }),
}))

it('remembers independent reading anchors, restores after measurement, and yields to user input', async () => {
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
  const heights: Record<string, number> = { A: 3000, B: 2300 }
  let selected = 'A'
  let top = 0
  let shift = 0
  let removed = false
  let hook: ReturnType<typeof useTimelineViewport>
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const turnId = this.dataset.turnId
    const start = turnId ? 20 + (Number(turnId.slice(1)) - 1) * 240 + (selected === 'A' ? shift : 0) - top : 0
    return { top: 100 + start, bottom: 100 + start + (turnId ? 240 : 500), height: turnId ? 240 : 500, left: 0, right: 800, width: 800, x: 0, y: 100 + start, toJSON() {} }
  })
  function View({ sessionId, loaded = true }: { sessionId: string; loaded?: boolean }) {
    const history = loaded ? {
      session: { id: sessionId }, revision: 'fixture', hasEarlier: false,
      entries: Array.from({ length: 8 }, (_, index) => ({ id: `${sessionId}${index + 1}`, parentId: null, timestamp: '2026-10-17T00:00:00Z', type: 'message', raw: { type: 'message', message: { role: 'user', content: `Question ${index + 1}` } } })).filter((entry) => !(removed && entry.id === 'A3')),
    } : undefined
    const viewport = useTimelineViewport({ selectedSessionId: sessionId, history, activeTurn: undefined, isActive: false })
    const { setMessageScrollArea } = viewport
    useLayoutEffect(() => { hook = viewport })
    const setArea = useCallback((node: HTMLDivElement | null) => {
      const element = node?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
      if (element) {
        Object.defineProperties(element, {
          scrollHeight: { configurable: true, get: () => heights[selected]! },
          clientHeight: { configurable: true, get: () => 500 },
          scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(heights[selected]! - 500, value)) } },
        })
        element.scrollTo = (options) => { element.scrollTop = (options as ScrollToOptions).top ?? top }
      }
      setMessageScrollArea(node)
    }, [setMessageScrollArea])
    return <div ref={setArea}><div data-slot="scroll-area-viewport"><SessionTimeline key={sessionId} history={history} error={false} isLoading={!loaded} onRetry={() => {}} overlayRoot={null} scrollViewport={viewport.scrollViewport} registerTimelineScroll={viewport.registerTimelineScroll} /></div></div>
  }
  const flush = async () => {
    await act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)) })
  }
  const resize = async () => { await act(() => observers.forEach((callback) => callback())) }
  const render = async (id: string, loaded = true) => {
    hook?.rememberReadingPosition()
    selected = id
    await act(() => root.render(<View sessionId={id} loaded={loaded} />))
  }
  try {
    await render('A')
    await flush()
    expect(top).toBe(2500)
    const element = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    const read = async (position: number) => {
      await act(() => element.dispatchEvent(new Event('wheel')))
      top = position
      await act(() => element.dispatchEvent(new Event('scroll')))
    }
    await read(580)
    await render('B')
    await flush()
    expect(top).toBe(1800)
    await read(340)

    // The saved record may initially be outside the virtualized DOM.
    virtual.hiddenIndex = 2
    await render('A', false)
    await flush()
    await render('A')
    await flush()
    expect(virtual.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start', behavior: 'auto' })
    virtual.hiddenIndex = -1
    await render('A')
    await flush()
    expect(top).toBe(580)
    expect(hook!.followLatest).toBe(false)
    expect(hook!.showScrollToBottom).toBe(true)

    shift = 350
    heights.A! += 350
    await resize()
    await flush()
    expect(top).toBe(930)
    heights.A! += 1000
    await resize()
    await flush()
    expect(top).toBe(930)

    await render('B')
    await flush()
    expect(top).toBe(340)
    await render('A')
    // User input cancels even a restoration already queued for the next frame.
    await read(110)
    await flush()
    await resize()
    await flush()
    expect(top).toBe(110)

    await read(930)
    await render('B')
    await flush()
    removed = true
    await render('A')
    await flush()
    await flush()
    expect(top).toBe(heights.A! - 500)
    expect(hook!.followLatest).toBe(true)
    await render('B')
    await flush()
    heights.A! += 400
    await render('A')
    await flush()
    expect(top).toBe(heights.A! - 500)
    expect(hook!.followLatest).toBe(true)
  } finally {
    await act(() => root.unmount())
    container.remove()
    rect.mockRestore()
    virtual.hiddenIndex = -1
    virtual.scrollToIndex.mockClear()
    vi.unstubAllGlobals()
  }
})
