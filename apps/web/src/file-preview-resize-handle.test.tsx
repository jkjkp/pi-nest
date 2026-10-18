// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FilePreviewResizeHandle } from './file-preview-resize-handle.js'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div')
document.body.append(container)
let root = createRoot(container)
let gridWidth = 1472
const measurements = new Set<() => void>()
const changed = vi.fn()
beforeEach(() => {
  gridWidth = 1472
  changed.mockClear()
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe() { measurements.add(this.callback) }
    disconnect() { measurements.delete(this.callback) }
  })
})
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(container); vi.unstubAllGlobals() })

function View() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(300)
  return <div ref={(node) => {
    ref.current = node
    if (node) node.getBoundingClientRect = () => ({ width: gridWidth } as DOMRect)
  }} data-width={width}><FilePreviewResizeHandle containerRef={ref} navigationWidth={272} width={width} onWidthChange={(next) => { changed(next); setWidth(next) }} /></div>
}

async function pointer(handle: HTMLElement, type: string, x: number, extras = {}) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, ...extras })
  await act(async () => handle.dispatchEvent(event))
  return event
}
async function setup() {
  await act(async () => root.render(<View />))
  const handle = container.querySelector<HTMLElement>('[role="separator"]')!
  handle.setPointerCapture = vi.fn()
  handle.hasPointerCapture = vi.fn(() => true)
  handle.releasePointerCapture = vi.fn()
  return handle
}

it('drags in both directions and clamps to half the content space excluding navigation', async () => {
  const handle = await setup()
  expect(handle.getAttribute('aria-valuemax')).toBe('600')
  expect((await pointer(handle, 'pointerdown', 1000)).defaultPrevented).toBe(true)
  expect(handle.setPointerCapture).toHaveBeenCalledWith(1)
  await pointer(handle, 'pointermove', 800)
  expect(changed).toHaveBeenLastCalledWith(500)
  await pointer(handle, 'pointermove', 100)
  expect(changed).toHaveBeenLastCalledWith(600)
  await pointer(handle, 'pointermove', 1800)
  expect(changed).toHaveBeenLastCalledWith(240)
  await pointer(handle, 'pointerup', 1800)
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
  expect(handle.dataset.resizing).toBe('false')
  changed.mockClear()
  await pointer(handle, 'pointermove', 300)
  expect(changed).not.toHaveBeenCalled()
})

it('ignores secondary pointers and stops resizing after cancellation or lost capture', async () => {
  const handle = await setup()
  await pointer(handle, 'pointerdown', 1000, { button: 2 })
  await pointer(handle, 'pointermove', 800)
  await pointer(handle, 'pointerdown', 1000, { isPrimary: false })
  await pointer(handle, 'pointermove', 800)
  expect(changed).not.toHaveBeenCalled()
  for (const end of ['pointercancel', 'lostpointercapture']) {
    await pointer(handle, 'pointerdown', 1000)
    await pointer(handle, 'pointermove', 900, { pointerId: 2 })
    await pointer(handle, end, 900)
    await pointer(handle, 'pointermove', 800)
    expect(changed).not.toHaveBeenCalled()
    expect(handle.dataset.resizing).toBe('false')
  }
})

it('supports keyboard adjustment and preserves the preferred width when the window shrinks', async () => {
  const handle = await setup()
  const key = async (value: string, shiftKey = false) => { await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true }))) }
  await key('ArrowLeft')
  expect(changed).toHaveBeenLastCalledWith(310)
  await key('ArrowRight', true)
  expect(changed).toHaveBeenLastCalledWith(260)
  await key('End')
  expect(changed).toHaveBeenLastCalledWith(600)
  changed.mockClear()
  gridWidth = 1072
  await act(async () => measurements.forEach((measure) => measure()))
  expect(handle.getAttribute('aria-valuemax')).toBe('400')
  expect(handle.getAttribute('aria-valuenow')).toBe('400')
  expect(changed).not.toHaveBeenCalled()
  gridWidth = 1472
  await act(async () => measurements.forEach((measure) => measure()))
  expect(handle.getAttribute('aria-valuenow')).toBe('600')
  await key('Home')
  expect(changed).toHaveBeenLastCalledWith(240)
  await act(async () => root.render(null))
  expect(measurements.size).toBe(0)
})
