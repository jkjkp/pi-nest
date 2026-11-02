// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MessageEditor } from './message-editor.js'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let props: ComponentProps<typeof MessageEditor>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  props = {
    edit: { entryId: 'user', revision: 'r', text: '/delete', status: 'editing' },
    attachments: { items: [], busy: false, add: vi.fn() } as unknown as ComponentProps<typeof MessageEditor>['attachments'],
    disabled: false, onChange: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn(), onError: vi.fn(),
  }
})
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = () => act(() => root.render(<MessageEditor {...props} />))
const button = (text: string) => [...container.querySelectorAll('button')].find((node) => node.textContent === text)!

it('focuses a neutral bubble editor, saves text, and submits literal commands with Enter or the send button', async () => {
  await render()
  const input = container.querySelector('textarea')!
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe('/delete')
  expect(container.querySelector('section')!.classList.contains('bg-muted')).toBe(true)
  expect(input.classList.contains('dark:bg-transparent')).toBe(true)
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'edited text')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith('edited text')
  const key = (options: KeyboardEventInit) => act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ...options })) })
  await key({ shiftKey: true }); await key({ isComposing: true })
  expect(props.onSubmit).not.toHaveBeenCalled()
  await key({}); await key({ ctrlKey: true }); await act(() => button('发送').click())
  expect(props.onSubmit).toHaveBeenCalledTimes(3)
  await act(() => button('取消').click())
  expect(props.onCancel).toHaveBeenCalledOnce()
})

it('locks in-flight content and only offers confirmation for unknown delivery', async () => {
  props.edit = { ...props.edit, status: 'submitting' }
  await render()
  expect(container.querySelector('textarea')!.disabled).toBe(true)
  expect(button('取消').disabled).toBe(true)
  expect(button('提交中…').disabled).toBe(true)
  props.edit = { ...props.edit, status: 'unknown', error: '连接已断开' }
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('连接已断开')
  expect(container.querySelector('[role="status"]')?.textContent).toContain('请勿重复发送')
  await act(() => button('确认发送状态').click())
  expect(props.onSubmit).toHaveBeenCalledOnce()
  expect(button('取消').disabled).toBe(true)
})

it('blocks empty or busy edits and allows attachment-only messages', async () => {
  props.edit.text = ' '
  await render()
  expect(button('发送').disabled).toBe(true)
  props.attachments = { ...props.attachments, items: [{ id: 'file', name: 'file.txt', size: 10, status: 'ready' }] }
  await render()
  expect(button('发送').disabled).toBe(false)
  props.attachments = { ...props.attachments, busy: true }
  await render()
  expect(button('发送').disabled).toBe(true)
  props.attachments = { ...props.attachments, busy: false }; props.disabled = true
  await render()
  expect(button('发送').disabled).toBe(true)
})
