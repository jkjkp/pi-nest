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
afterEach(() => vi.unstubAllGlobals())

function setup() {
  const listeners = new Map<string, () => void>()
  const viewport = { scrollHeight: 1000, clientHeight: 500, scrollTop: 500, firstElementChild: null, addEventListener: (type: string, listener: () => void) => listeners.set(type, listener), removeEventListener: (type: string) => listeners.delete(type) }
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  let resize: () => void = () => undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  hooks.state = 0; hooks.setters = []; hooks.viewport = viewport; hooks.effects = []; hooks.layouts = []
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Exercise the hook with mocked React effects and scroll geometry.
  const hook = useTimelineViewport({ selectedSessionId: 'A', history: undefined, activeTurn: undefined, isActive: false, inspectorOpen: false, setInspectorOpen: vi.fn() })
  const cleanups = hooks.effects.map((effect) => effect())
  return { hook, viewport, frames, resize: () => resize(), scroll: () => listeners.get('scroll')?.(), cleanup: () => { for (const cleanup of cleanups) cleanup?.() }, flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)) } }
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
    test.viewport.scrollTop = 100
    test.scroll()
    test.viewport.scrollHeight = 1400
    test.resize()
    test.hook.followFinalAnswer()
    expect(test.frames.size).toBe(0)
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
    test.viewport.scrollTop = 100
    test.scroll()
    test.scroll()
    expect(hooks.setters[0]).toHaveBeenCalledExactlyOnceWith(false)
    expect(hooks.setters[1]).toHaveBeenCalledExactlyOnceWith(true)
  } finally { test.cleanup() }
})
