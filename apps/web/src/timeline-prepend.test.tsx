// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SessionTimeline } from './session-timeline.js'
import type { PiSessionHistoryResponse } from './history.js'

it.each([0, 60, 1620])('anchors the current message after pagination, streaming, and continued scrolling (top: %s)', async (readingTop) => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const observers = new Map<ResizeObserverCallback, Set<Element>>()
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    constructor(callback: ResizeObserverCallback) { observers.set(callback, this.targets) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  })
  let intersect: IntersectionObserverCallback | undefined
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback }
    observe() {}
    disconnect() {}
  })
  const viewport = document.createElement('div')
  document.body.append(viewport)
  const root = createRoot(viewport)
  const sizes: Record<string, number> = { older: 700, current: 1200, live: 900 }
  let top = 0
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 500 },
    scrollHeight: { get: () => 20 + sizes.current! + sizes.live! + (prepended ? sizes.older! : 0) },
    scrollTop: { get: () => top, set: (value: number) => { top = value } },
  })
  viewport.scrollTo = (options) => {
    top = (options as ScrollToOptions).top ?? top
    viewport.dispatchEvent(new Event('scroll'))
  }
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this === viewport ? 500 : sizes[this.querySelector<HTMLElement>('[data-turn-id]')?.dataset.turnId ?? ''] ?? 20
  })
  const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  const entry = (id: string) => ({ id, parentId: null, timestamp: '2026-10-19T00:00:00Z', type: 'message', raw: { type: 'message', message: { role: 'user', content: id } } })
  let prepended = false
  let loading = false
  const load = vi.fn()
  const render = async () => {
    const history: PiSessionHistoryResponse = { session: { id: 'one' }, revision: 'fixture', hasEarlier: !prepended, entries: [...(prepended ? [entry('older')] : []), entry('current'), entry('live')] }
    await act(() => root.render(<SessionTimeline history={history} error={false} isLoading={false} hasEarlier={!prepended} isLoadingEarlier={loading} onLoadEarlier={load} onRetry={() => {}} overlayRoot={null} scrollViewport={viewport} />))
  }
  const flush = async () => {
    for (let i = 0; i < 5 && frames.size; i++) {
      await act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)) })
    }
  }
  const scroll = async (position: number) => {
    top = position
    await act(() => viewport.dispatchEvent(new Event('scroll')))
  }
  const resize = async () => {
    await act(() => {
      for (const [callback, targets] of observers) {
        const entries = [...targets].filter((node) => node.hasAttribute('data-index')).map((target) => ({ target, borderBoxSize: [{ blockSize: sizes[target.querySelector<HTMLElement>('[data-turn-id]')!.dataset.turnId!], inlineSize: 800 }] }) as unknown as ResizeObserverEntry)
        if (entries.length) callback(entries, {} as ResizeObserver)
      }
    })
    await flush()
  }
  try {
    await render()
    await resize()
    await flush()
    await scroll(100)
    await act(() => vi.advanceTimersByTime(160))
    await act(() => intersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(load).toHaveBeenCalledOnce()
    loading = true
    await render()
    await scroll(readingTop)
    sizes.live! += 500
    await resize()
    expect(top).toBe(readingTop)
    sizes.live! -= 350
    await resize()
    expect(top).toBe(readingTop)
    prepended = true
    loading = false
    await render()
    await resize()
    await flush()
    expect(top).toBe(readingTop + sizes.older!)
    expect(viewport.querySelector('[data-turn-id="current"]')).not.toBeNull()
  } finally {
    await act(() => root.unmount())
    viewport.remove()
    height.mockRestore()
    width.mockRestore()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})
