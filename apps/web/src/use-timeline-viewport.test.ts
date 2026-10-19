import { afterEach, expect, it, vi } from 'vitest'
import { useTimelineViewport } from './use-timeline-viewport.js'

const hooks = vi.hoisted(() => ({ state: 0, setters: [] as Array<ReturnType<typeof vi.fn>>, viewport: undefined as unknown, effects: [] as Array<() => void | (() => void)>, layouts: [] as Array<() => void | (() => void)> }))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const setter = vi.fn(); hooks.setters.push(setter); return [hooks.state++ === 3 ? hooks.viewport : initial, setter] },
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
  useLayoutEffect: (effect: () => void | (() => void)) => hooks.layouts.push(effect),
}))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function setup(latestSteeringId?: string, selectedSessionId = 'A') {
  const listeners = new Map<string, (event?: unknown) => void>()
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  const viewport = { scrollTo: vi.fn((options: ScrollToOptions) => { if (options.behavior !== 'smooth') viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, options.top ?? viewport.scrollTop)) }), scrollHeight: 1000, clientHeight: 500, scrollTop: 500, firstElementChild: null, addEventListener: (type: string, listener: (event?: unknown) => void) => listeners.set(type, listener), removeEventListener: (type: string) => listeners.delete(type) }
  class TestElement {
    isConnected = true
    classList = { contains: (name: string) => name === 'execution-collapse' }
    closest(selector: string) { return selector === '[data-execution-toggle]' ? this : null }
  }
  vi.stubGlobal('Element', TestElement)
  const panel = new TestElement()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  let resize: () => void = () => undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  hooks.state = 0; hooks.setters = []; hooks.viewport = viewport; hooks.effects = []; hooks.layouts = []
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Exercise the hook with mocked React effects and scroll geometry.
  const hook = useTimelineViewport({ selectedSessionId, history: undefined, activeTurn: undefined, latestSteeringId, isActive: false })
  const cleanups = hooks.effects.map((effect) => effect())
  return { hook, viewport, frames, panel, transition: (type: string) => listeners.get(type)?.({ type, target: panel, propertyName: 'grid-template-rows' }), click: () => listeners.get('click')?.({ target: panel }), resize: () => resize(), wheel: () => listeners.get('wheel')?.({ type: 'wheel' }), scroll: () => listeners.get('scroll')?.(), scrollEnd: () => listeners.get('scrollend')?.(), cleanup: () => { for (const cleanup of cleanups) cleanup?.() }, flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)) } }
}

it('defers resize-driven scroll writes and coalesces streaming follow requests', () => {
  const test = setup()
  try {
    test.viewport.scrollHeight = 1400
    test.resize()
    expect(test.viewport.scrollTop).toBe(500)
    test.hook.followFinalAnswer()
    test.hook.followFinalAnswer()
    expect(test.frames.size).toBe(1)
    test.flush()
    expect(test.viewport.scrollTop).toBe(900)
    test.scroll()
    expect(test.frames.size).toBe(0)
  } finally { test.cleanup() }
})

it('does not force the user back to the bottom after scrolling up', () => {
  const test = setup()
  try {
    test.wheel()
    test.viewport.scrollTop = 100
    test.scroll()
    test.viewport.scrollHeight = 1400
    test.resize()
    test.hook.followFinalAnswer()
    expect(test.frames.size).toBe(0)
    expect(test.viewport.scrollTop).toBe(100)
  } finally { test.cleanup() }
})

it.each([false, true])('keeps slow upward scrolling paused through completion (collapse: %s)', (collapse) => {
  const test = setup()
  try {
    test.hook.setFollowingLatest(false)
    test.hook.setFollowingLatest(true)
    test.hook.followFinalAnswer()
    if (collapse) test.transition('transitionrun')
    test.wheel()
    test.viewport.scrollTop = 480
    test.scroll()
    test.viewport.scrollHeight = 1020
    test.resize()
    test.viewport.scrollTop = 460
    test.scroll()
    if (collapse) test.transition('transitionend')
    test.scrollEnd()
    test.flush()
    test.flush()
    expect(test.viewport.scrollTop).toBe(460)
    expect(hooks.setters[0]).toHaveBeenLastCalledWith(false)
    test.hook.followFinalAnswer()
    test.flush()
    expect(test.viewport.scrollTop).toBe(460)
  } finally { test.cleanup() }
})

it('resumes following when the reader scrolls down into the bottom band', () => {
  const test = setup()
  try {
    test.wheel()
    test.viewport.scrollTop = 400
    test.scroll()
    test.viewport.scrollTop = 460
    test.scroll()
    expect(hooks.setters[0]).toHaveBeenLastCalledWith(true)
    test.viewport.scrollHeight = 1100
    test.resize()
    test.flush()
    expect(test.viewport.scrollTop).toBe(600)
  } finally { test.cleanup() }
})

it('honors upward input when streaming height changes before the scroll callback', () => {
  const test = setup()
  try {
    test.hook.setFollowingLatest(false)
    test.hook.setFollowingLatest(true)
    test.wheel()
    test.viewport.scrollTop = 350
    test.viewport.scrollHeight = 1100
    test.scroll()
    test.flush()
    expect(test.viewport.scrollTop).toBe(350)
    expect(hooks.setters[0]).toHaveBeenLastCalledWith(false)
  } finally { test.cleanup() }
})

it('follows a steering bubble only while the user is following the latest messages', () => {
  const test = setup('steering-1')
  try {
    const steeringLayout = hooks.layouts.at(-1)!
    steeringLayout()
    test.flush()
    expect(test.viewport.scrollTop).toBe(test.viewport.scrollHeight)
    test.wheel()
    test.viewport.scrollTop = 100
    test.scroll()
    steeringLayout()
    test.flush()
    expect(test.viewport.scrollTop).toBe(100)
  } finally { test.cleanup() }
})

it('cancels a pending old-session scroll when the session effect cleans up', () => {
  const test = setup()
  try {
    const cleanup = hooks.layouts[0]!()
    test.hook.followFinalAnswer()
    expect(test.frames.size).toBe(1)
    cleanup?.()
    expect(test.frames.size).toBe(0)
  } finally { test.cleanup() }
})

it('does not enqueue React state updates for unchanged scroll-follow flags', () => {
  const test = setup()
  try {
    test.scroll()
    test.resize()
    test.hook.setFollowingLatest(true)
    expect(hooks.setters[0]).not.toHaveBeenCalled()
    expect(hooks.setters[1]).not.toHaveBeenCalled()
    test.wheel()
    test.viewport.scrollTop = 100
    test.scroll()
    test.scroll()
    expect(hooks.setters[0]).toHaveBeenCalledExactlyOnceWith(false)
    expect(hooks.setters[1]).toHaveBeenCalledExactlyOnceWith(true)
  } finally { test.cleanup() }
})

it('waits until automatic collapse finishes before following the changed height', () => {
  const test = setup()
  try {
    test.transition('transitionrun')
    test.viewport.scrollHeight = 1400
    test.resize()
    test.hook.followFinalAnswer()
    test.flush()
    expect(test.viewport.scrollTop).toBe(500)
    test.transition('transitionend')
    test.flush()
    test.flush()
    expect(test.viewport.scrollTop).toBe(900)
  } finally { test.cleanup() }
})

it('cancels queued page follow when the reader toggles execution, including keyboard clicks', () => {
  const test = setup()
  try {
    test.hook.followFinalAnswer()
    test.click()
    expect(test.frames.size).toBe(0)
    test.transition('transitionrun')
    test.viewport.scrollHeight = 1400
    test.resize()
    test.transition('transitionend')
    test.flush()
    test.flush()
    expect(test.viewport.scrollTop).toBe(500)
  } finally { test.cleanup() }
})

it('handles transition reversal and a panel unmount without leaving page follow suspended', () => {
  const test = setup()
  try {
    test.transition('transitionrun')
    test.transition('transitioncancel')
    test.transition('transitionrun')
    test.viewport.scrollHeight = 1400
    test.flush()
    expect(test.viewport.scrollTop).toBe(500)
    test.panel.isConnected = false
    test.hook.followFinalAnswer()
    test.flush()
    expect(test.viewport.scrollTop).toBe(900)
  } finally { test.cleanup() }
})


it('finishes a long return within 1500ms without restarting smooth scroll on resize', () => {
  vi.useFakeTimers()
  const test = setup()
  try {
    test.wheel()
    test.viewport.scrollTop = 0
    test.viewport.scrollHeight = 1_000_000
    test.hook.scrollToBottom()
    expect(test.viewport.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1_000_000, behavior: 'smooth' })
    for (let step = 0; step < 3; step++) {
      vi.advanceTimersByTime(400)
      test.viewport.scrollHeight += 1000
      test.resize()
      test.scroll()
      test.flush()
    }
    expect(test.viewport.scrollTo).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    expect(test.viewport.scrollTo).toHaveBeenLastCalledWith({ top: 1_003_000, behavior: 'instant' })
    expect(test.viewport.scrollTop).toBe(1_002_500)
    test.viewport.scrollHeight += 1000
    test.resize()
    test.scroll()
    test.flush()
    expect(test.viewport.scrollTop).toBe(1_003_500)
  } finally { test.cleanup() }
})

it('snaps to the actual bottom when smooth scroll ends before the deadline', () => {
  vi.useFakeTimers()
  const test = setup()
  try {
    test.hook.scrollToBottom()
    test.viewport.scrollHeight = 1400
    test.scrollEnd()
    expect(test.viewport.scrollTop).toBe(900)
    const calls = test.viewport.scrollTo.mock.calls.length
    vi.advanceTimersByTime(2000)
    expect(test.viewport.scrollTo).toHaveBeenCalledTimes(calls)
  } finally { test.cleanup() }
})

it.each(['wheel', 'jump', 'cleanup', 'execution'])('cancels the return deadline on %s', (action) => {
  vi.useFakeTimers()
  const test = setup()
  try {
    const cleanupSession = hooks.layouts[0]!()
    test.hook.scrollToBottom()
    vi.advanceTimersByTime(500)
    if (action === 'wheel') test.wheel()
    if (action === 'jump') test.hook.jumpToTurn('old-turn', vi.fn(), 'start')
    if (action === 'cleanup') cleanupSession?.()
    if (action === 'execution') test.click()
    const calls = test.viewport.scrollTo.mock.calls.length
    vi.advanceTimersByTime(2000)
    test.flush()
    expect(test.viewport.scrollTo).toHaveBeenCalledTimes(calls)
  } finally { test.cleanup() }
})

it('replaces the previous deadline on another click and skips animation for reduced motion', () => {
  vi.useFakeTimers()
  const test = setup()
  try {
    test.hook.scrollToBottom()
    vi.advanceTimersByTime(1000)
    test.hook.scrollToBottom()
    vi.advanceTimersByTime(500)
    expect(test.viewport.scrollTo.mock.calls.every(([options]) => options.behavior === 'smooth')).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(test.viewport.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'instant' })
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    test.viewport.scrollTop = 100
    test.hook.scrollToBottom()
    expect(test.viewport.scrollTop).toBe(500)
    expect(vi.getTimerCount()).toBe(0)
  } finally { test.cleanup() }
})


it('does not scroll a long project home to the bottom as its list loads', () => {
  const test = setup(undefined, '')
  try {
    test.viewport.scrollTop = 0
    test.viewport.scrollHeight = 5000
    test.resize()
    test.hook.followFinalAnswer()
    test.flush()
    expect(test.viewport.scrollTop).toBe(0)
    expect(test.frames.size).toBe(0)
  } finally { test.cleanup() }
})

it('restores a layout position without owning or changing panel state', () => {
  const test = setup()
  try {
    test.viewport.scrollTop = 120
    test.hook.rememberLayoutPosition()
    test.viewport.scrollTop = 240
    test.hook.restoreLayoutPosition()
    expect(test.viewport.scrollTop).toBe(120)
    test.viewport.scrollTop = 300
    test.hook.restoreLayoutPosition()
    expect(test.viewport.scrollTop).toBe(300)
  } finally { test.cleanup() }
})
