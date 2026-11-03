// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSessionRead } from './use-session-read.js'
import { useWorkspaceStore } from './workspace-store.js'

let root: ReturnType<typeof createRoot>; let container: HTMLDivElement
const frames = new Map<number, FrameRequestCallback>()
const onRead = vi.fn((sessionId: string, runId: string) => useWorkspaceStore.getState().markSessionRead(sessionId, runId))
let visible = 'visible'; let sequence = 0
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible as DocumentVisibilityState)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  visible = 'visible'; frames.clear(); onRead.mockClear()
  useWorkspaceStore.setState({ sessionNotifications: { one: { completedRunId: 'done' }, two: { completedRunId: 'other' } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function Reader({ sessionId, ready }: { sessionId: string; ready: boolean }) { useSessionRead(sessionId, ready, onRead); return <p>Reply for {sessionId}</p> }
async function render(sessionId = 'one', ready = true) { await act(() => root.render(<Reader sessionId={sessionId} ready={ready} />)) }
async function paint() { await act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)) }) }

it('acknowledges a displayed reply once and only after the reading view is ready', async () => {
  await render('one', false); await paint()
  expect(onRead).not.toHaveBeenCalled()
  await render(); expect(onRead).not.toHaveBeenCalled()
  await paint()
  expect(onRead).toHaveBeenCalledExactlyOnceWith('one', 'done')
  await render(); await paint()
  expect(onRead).toHaveBeenCalledTimes(1)
})

it('waits for a visible page and cancels acknowledgement if it becomes hidden before paint', async () => {
  visible = 'hidden'; await render(); await paint()
  expect(onRead).not.toHaveBeenCalled()
  visible = 'visible'; await act(() => document.dispatchEvent(new Event('visibilitychange')))
  visible = 'hidden'; await act(() => document.dispatchEvent(new Event('visibilitychange'))); await paint()
  expect(onRead).not.toHaveBeenCalled()
  visible = 'visible'; await act(() => document.dispatchEvent(new Event('visibilitychange'))); await paint()
  expect(onRead).toHaveBeenCalledExactlyOnceWith('one', 'done')
})

it('cancels the old view when quickly switching sessions or hiding the reader', async () => {
  await render(); await render('two'); await paint()
  expect(onRead).toHaveBeenCalledExactlyOnceWith('two', 'other')
  await render(); await render('one', false); await paint()
  expect(useWorkspaceStore.getState().sessionNotifications.one.readRunId).toBeUndefined()
})

it('does not acknowledge an old loaded view after another run starts or completes', async () => {
  await render()
  await act(() => useWorkspaceStore.getState().trackPendingRun('one', 'next'))
  await paint(); expect(onRead).not.toHaveBeenCalled()
  await render('one', false)
  await act(() => useWorkspaceStore.getState().finishNotification('one', 'next', true, true))
  await paint(); expect(onRead).not.toHaveBeenCalled()
  await render(); await paint()
  expect(onRead).toHaveBeenCalledExactlyOnceWith('one', 'next')
})
