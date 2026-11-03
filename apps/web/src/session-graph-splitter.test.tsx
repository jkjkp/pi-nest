// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionGraphSplitter } from './session-graph-splitter.js'
import { clampGraphSplitRatio } from './session-graph-model.js'

let container: HTMLDivElement; let root: ReturnType<typeof createRoot>
const committed = vi.fn()
function Fixture({ width = 1000 }: { width?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [saved, setSaved] = useState(0.45)
  const [drag, setDrag] = useState<number>()
  const ratio = clampGraphSplitRatio(drag ?? saved, width)
  return <div ref={ref} style={{ gridTemplateColumns: `${ratio}fr ${1 - ratio}fr` }}><input defaultValue="keep draft" /><SessionGraphSplitter containerRef={ref} width={width} ratio={ratio} onChange={setDrag} onCommit={(next) => { committed(next); setSaved(next); setDrag(undefined) }} /></div>
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  committed.mockClear()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 1000 } as DOMRect)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(width = 1000) {
  await act(() => root.render(<Fixture width={width} />))
  const handle = container.querySelector<HTMLElement>('[role="separator"]')!
  handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = vi.fn(() => true); handle.releasePointerCapture = vi.fn()
  return handle
}
async function pointer(handle: HTMLElement, type: string, clientX: number, pointerId = 1) {
  await act(() => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId, clientX })))
}
it('previews mouse resizing without saving until release and retains the conversation DOM', async () => {
  const handle = await mount(); const draft = container.querySelector('input')
  await pointer(handle, 'pointerdown', 550)
  await pointer(handle, 'pointermove', 700)
  expect(handle.getAttribute('aria-valuenow')).toBe('60')
  expect(committed).not.toHaveBeenCalled()
  await pointer(handle, 'pointerup', 700)
  expect(committed).toHaveBeenCalledExactlyOnceWith(0.6)
  expect(container.querySelector('input')).toBe(draft)
  expect(draft?.value).toBe('keep draft')
  await pointer(handle, 'pointermove', 800)
  expect(committed).toHaveBeenCalledTimes(1)
})
it.each(['pointercancel', 'lostpointercapture'])('finishes on %s and ignores other pointers', async (finish) => {
  const handle = await mount()
  await pointer(handle, 'pointerdown', 550)
  await pointer(handle, 'pointermove', 700, 2)
  expect(handle.getAttribute('aria-valuenow')).toBe('45')
  await pointer(handle, 'pointermove', 900)
  expect(handle.getAttribute('aria-valuenow')).toBe('64')
  await pointer(handle, finish, 900)
  await pointer(handle, 'pointermove', 600)
  expect(committed).toHaveBeenCalledExactlyOnceWith(0.64)
})
it('supports keyboard adjustment and clamps both pane widths', async () => {
  const handle = await mount()
  const key = (key: string) => act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
  await key('ArrowRight'); expect(committed).toHaveBeenLastCalledWith(0.46)
  await key('Home'); expect(committed).toHaveBeenLastCalledWith(0.32)
  await key('End'); expect(committed).toHaveBeenLastCalledWith(0.64)
  expect(clampGraphSplitRatio(0.7, 1000)).toBe(0.64)
  expect(clampGraphSplitRatio(0.7, 1600)).toBe(0.7)
  expect(clampGraphSplitRatio(Number.NaN, 1000)).toBe(0.45)
})
