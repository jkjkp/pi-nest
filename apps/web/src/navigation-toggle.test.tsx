// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NavigationToggle } from './navigation-toggle.js'

let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
const content = () => document.querySelector('[data-slot="tooltip-content"]')
const pointer = (button: HTMLButtonElement, type: string, pointerType = 'mouse') =>
  button.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, relatedTarget: type === 'pointerout' ? document.body : null }))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it.each([[true, '收起侧边栏'], [false, '展开侧边栏']] as const)('shows the %s toggle label only while hovered', async (expanded, label) => {
  const onToggle = vi.fn()
  await act(() => root.render(<NavigationToggle controls="navigation" expanded={expanded} onToggle={onToggle} />))
  const button = container.querySelector('button')!
  expect(button.getAttribute('aria-label')).toBe(label)
  expect(button.getAttribute('aria-expanded')).toBe(String(expanded))
  await act(() => { pointer(button, 'pointerover'); pointer(button, 'pointermove') })
  expect(content()?.textContent).toContain(label)
  await act(() => button.click())
  expect(onToggle).toHaveBeenCalledOnce()
  await act(() => pointer(button, 'pointerout'))
  expect(content()).toBeNull()
  await act(() => { pointer(button, 'pointerover'); pointer(button, 'pointermove') })
  expect(content()?.textContent).toContain(label)
  await act(() => pointer(button, 'pointerout'))
  expect(content()).toBeNull()
})

it('keeps the tooltip closed when the button receives focus', async () => {
  await act(() => root.render(<NavigationToggle controls="navigation" expanded onToggle={() => {}} />))
  const button = container.querySelector('button')!
  await act(() => button.focus())
  expect(document.activeElement).toBe(button)
  expect(content()).toBeNull()
})

it('does not show a tooltip for touch input', async () => {
  await act(() => root.render(<NavigationToggle controls="navigation" expanded onToggle={() => {}} />))
  const button = container.querySelector('button')!
  await act(() => { pointer(button, 'pointerover', 'touch'); pointer(button, 'pointermove', 'touch'); button.focus() })
  expect(content()).toBeNull()
})

it('allows Escape to dismiss the hovered tooltip', async () => {
  await act(() => root.render(<NavigationToggle controls="navigation" expanded onToggle={() => {}} />))
  const button = container.querySelector('button')!
  await act(() => { pointer(button, 'pointerover'); pointer(button, 'pointermove') })
  expect(content()).not.toBeNull()
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(content()).toBeNull()
})
