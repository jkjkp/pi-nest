// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { SessionInspector } from './session-inspector.js'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div')
document.body.append(container)
let root = createRoot(container)
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(container) })

async function openInspector() {
  await act(async () => root.render(<SessionInspector run={undefined} session={{ id: 'session-one', cwd: '/fixture/project' }} />))
  const trigger = container.querySelector<HTMLButtonElement>('button')!
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => trigger.click())
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('session-one')
  return trigger
}

it.each(['close-button', 'escape', 'outside'])('opens an information dialog and closes through %s', async (method) => {
  const trigger = await openInspector()
  await act(async () => {
    if (method === 'close-button') document.querySelector<HTMLButtonElement>('[aria-label="关闭会话检查器"]')!.click()
    if (method === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    if (method === 'outside') {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      document.body.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      document.body.click()
    }
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
