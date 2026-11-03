// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { PiSessionHistoryResponse } from '@pi-nest/contracts'
import { SessionGraphPreview } from './session-graph-preview.js'
import { useWorkspaceStore } from './workspace-store.js'

let history: PiSessionHistoryResponse | undefined
let fetching = false; let failed = false
const ready: PiSessionHistoryResponse = { session: { id: 'other' }, entries: [], revision: 'r', hasEarlier: false }
const cancelJump = vi.fn()
vi.mock('./use-session-history.js', () => ({ useSessionHistory: () => ({ history, historyError: failed,
  historyQuery: { isPending: !history, isSuccess: Boolean(history) && !failed, isFetching: fetching, hasPreviousPage: false }, turnIndexQuery: {}, cancelTurnJump: cancelJump,
}) }))
vi.mock('./session-timeline.js', () => ({ SessionTimeline: () => <div>Latest message</div> }))
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: ReactNode }) => <div><div data-slot="scroll-area-viewport"><div>{children}</div></div></div> }))
afterEach(() => { fetching = false; failed = false; vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each([true, false])('opens the latest message, handles measurement, and returns to latest on another click (cached: %s)', async (cached) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames = new Map<number, FrameRequestCallback>(); let id = 0
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++id, fn); return id })
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key))
  const observers = new Set<() => void>()
  vi.stubGlobal('ResizeObserver', class { callback: () => void; constructor(callback: () => void) { this.callback = callback } observe() { observers.add(this.callback) } disconnect() { observers.delete(this.callback) } })
  useWorkspaceStore.setState({ runs: {}, sessionNotifications: {} })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  history = cached ? ready : undefined
  let selection = { sessionId: 'other' }
  const render = () => act(() => root.render(<SessionGraphPreview selection={selection} branchDisabled={false} onBranch={async () => {}} visible onRead={vi.fn()} />))
  const flush = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn(0)) })
  const resize = () => act(() => observers.forEach((fn) => fn()))
  try {
    await render()
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? container.firstElementChild as HTMLElement
    expect(viewport).not.toBeNull()
    let height = 1000; let top = 0
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => height }, clientHeight: { get: () => 300 },
      scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(height - 300, value)) } },
    })
    viewport.scrollTo = (options) => { viewport.scrollTop = (options as ScrollToOptions).top ?? top }
    if (!cached) { await flush(); expect(top).toBe(0); history = ready; await render() }
    await flush(); expect(top).toBe(700)
    height = 1600; await resize(); await flush(); expect(top).toBe(1300)
    await act(() => viewport.dispatchEvent(new Event('wheel')))
    top = 100
    await act(() => viewport.dispatchEvent(new Event('scroll')))
    height = 2000; await resize(); await flush(); expect(top).toBe(100)
    selection = { sessionId: 'other' }
    await render(); await flush(); expect(top).toBe(1700)
    // A late virtual-list correction is layout movement, not another reader interruption.
    top = 1400
    await act(() => viewport.dispatchEvent(new Event('scroll')))
    await flush(); expect(top).toBe(1700)
    expect(container.querySelector('[data-slot="scroll-area-viewport"]')).toBe(viewport)
  } finally { await act(() => root.unmount()); container.remove() }
})

it.each(['hidden', 'refreshing', 'failed', 'wrong-session'] as const)('keeps cached preview replies unread while %s', async (state) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useWorkspaceStore.setState({ runs: {}, sessionNotifications: { other: { completedRunId: 'done' } } })
  history = state === 'wrong-session' ? { ...ready, session: { id: 'previous' } } : ready
  fetching = state === 'refreshing'; failed = state === 'failed'
  const onRead = vi.fn((id: string, runId: string) => useWorkspaceStore.getState().markSessionRead(id, runId))
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = (visible: boolean) => act(() => root.render(<SessionGraphPreview selection={{ sessionId: 'other' }} branchDisabled={false} onBranch={async () => {}} visible={visible} onRead={onRead} />))
  const paint = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  try {
    await render(state !== 'hidden'); await paint()
    expect(onRead).not.toHaveBeenCalled()
    history = ready; fetching = false; failed = false
    await render(true); await paint()
    expect(onRead).toHaveBeenCalledExactlyOnceWith('other', 'done')
  } finally { await act(() => root.unmount()); container.remove() }
})
