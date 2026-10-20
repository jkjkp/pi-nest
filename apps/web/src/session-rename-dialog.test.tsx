// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionRenameDialog } from './session-rename-dialog.js'

let container: HTMLDivElement
let composer: HTMLTextAreaElement
let root: Root
const onRename = vi.fn()
const onClose = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); composer = document.createElement('textarea')
  document.body.append(container, composer); root = createRoot(container)
  onRename.mockReset().mockResolvedValue(undefined); onClose.mockReset()
})
afterEach(async () => {
  await act(async () => { root.unmount(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  container.remove(); composer.remove(); vi.unstubAllGlobals()
})
async function render() {
  await act(async () => root.render(<SessionRenameDialog session={{ id: 'one', name: 'Old name' }} onRename={onRename} onClose={() => { onClose(); root.render(null) }} onCloseAutoFocus={(event) => { event.preventDefault(); composer.focus() }} />))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
function input() { return document.querySelector<HTMLInputElement>('[role="dialog"] input')! }
async function change(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit() { await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }

it('focuses and selects the current name, then restores composer focus after Escape', async () => {
  await render()
  expect(document.activeElement).toBe(input())
  expect(input().selectionStart).toBe(0)
  expect(input().selectionEnd).toBe('Old name'.length)
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(onClose).toHaveBeenCalledOnce()
  expect(onRename).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(composer)
})

it('preserves the name after save failure, retries through form submission and restores focus', async () => {
  onRename.mockRejectedValueOnce(new Error('failed'))
  await render()
  await change('  New name  ')
  await submit()
  expect(onRename).toHaveBeenCalledExactlyOnceWith('one', 'New name')
  expect(input().value).toBe('  New name  ')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('重命名失败')
  expect(onClose).not.toHaveBeenCalled()
  await submit()
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(onRename).toHaveBeenCalledTimes(2)
  expect(onClose).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(composer)
})
