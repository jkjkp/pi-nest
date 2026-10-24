// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MermaidDiagram } from './mermaid-diagram.js'
import mermaid from 'mermaid'

vi.mock('mermaid', () => ({ default: {
  initialize: vi.fn(),
  render: vi.fn().mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" /></svg>' }),
} }))
vi.mock('dompurify', () => ({ default: { sanitize: (svg: string) => svg } }))

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let nextFrame: FrameRequestCallback | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { nextFrame = undefined })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  nextFrame = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => {
    root.render(<MermaidDiagram source="graph TD; A-->B" />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await vi.waitFor(() => expect(container.querySelector('svg rect')).not.toBeNull())
}

const canvas = () => document.querySelector<HTMLElement>('[aria-label="图表画布，可缩放和自由平移"]')!
const transform = () => canvas().firstElementChild?.getAttribute('style')
async function wheel(options: WheelEventInit) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options })
  // Happy DOM's WheelEvent omits the inherited MouseEvent fields.
  Object.defineProperties(event, {
    ctrlKey: { value: options.ctrlKey ?? false }, shiftKey: { value: options.shiftKey ?? false },
    clientX: { value: 100 }, clientY: { value: 100 },
  })
  await act(() => {
    canvas().dispatchEvent(event)
    const callback = nextFrame
    nextFrame = undefined
    callback?.(0)
  })
  return event
}

it('passes ordinary inline wheel events to the page and reserves Ctrl + wheel for zoom', async () => {
  await render()
  const bubbled = vi.fn()
  container.addEventListener('wheel', bubbled)
  const initial = transform()
  for (const options of [{ deltaY: -100 }, { deltaY: 100 }, { deltaY: -10 }, { deltaX: 10, deltaY: 5 }, { deltaY: 100, shiftKey: true }]) {
    expect((await wheel(options)).defaultPrevented).toBe(false)
    expect(transform()).toBe(initial)
  }
  expect(bubbled).toHaveBeenCalledTimes(5)
  expect((await wheel({ deltaY: -100, ctrlKey: true })).defaultPrevented).toBe(true)
  expect(transform()).not.toBe(initial)
  expect(bubbled).toHaveBeenCalledTimes(5)
})

it('retains ordinary wheel zoom and trackpad pan in the expanded viewer', async () => {
  await render()
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="放大查看 Mermaid 图表"]')!.click())
  const initial = transform()
  expect((await wheel({ deltaY: -100 })).defaultPrevented).toBe(true)
  expect(transform()).not.toBe(initial)
  const zoomed = transform()
  expect((await wheel({ deltaY: 10 })).defaultPrevented).toBe(true)
  expect(transform()).not.toBe(zoomed)
})

it('keeps the full diagram frame while a virtualized diagram renders again', async () => {
  await render()
  await act(() => root.render(null))
  let finish!: (result: { svg: string; diagramType: string }) => void
  vi.mocked(mermaid.render).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await act(async () => {
    root.render(<MermaidDiagram source="graph TD; A-->B" />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const figure = container.querySelector('figure')!
  const toolbar = figure.querySelector('figcaption')!
  const frame = toolbar.nextElementSibling!
  expect(frame.classList.contains('h-80')).toBe(true)
  expect(frame.textContent).toContain('正在生成')
  expect(figure.querySelectorAll('button:disabled').length).toBeGreaterThan(0)
  await act(() => finish({ svg: '<svg viewBox="0 0 200 100"><rect /></svg>', diagramType: 'flowchart-v2' }))
  expect(container.querySelector('figure')).toBe(figure)
  expect(figure.querySelector('figcaption')).toBe(toolbar)
  expect(toolbar.nextElementSibling).toBe(frame)
  expect(frame.querySelector('[role="region"]')).not.toBeNull()
})
