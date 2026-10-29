// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionNavigation } from './session-navigation.js'
import { useWorkspaceStore } from './workspace-store.js'

let container: HTMLDivElement
let root: Root
let props: ComponentProps<typeof SessionNavigation>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useWorkspaceStore.setState({ sessionNotifications: {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  props = {
    collapsedProjectKeys: {}, error: null, isLoading: false, mutationSessionId: undefined,
    onClone: vi.fn(async () => {}), onDelete: vi.fn(async () => {}), onSelect: vi.fn(), onRename: vi.fn(async () => {}), onProjectOrderChange: vi.fn(), onNewConversation: vi.fn(), onAddProject: vi.fn(), onRemoveProject: vi.fn(), onRevealProject: vi.fn(async () => {}), onSessionOrderChange: vi.fn(), onToggleProject: vi.fn(),
    projects: [{ key: 'cwd:/fixture', cwd: '/fixture', name: 'Fixture', sessions: [{ id: 'one', name: '当前对话' }, { id: 'two', name: '另一会话' }, { id: 'running', name: '运行中的会话' }] }],
    selectedSessionId: 'one', runs: { running: { status: 'running', turns: [], systemEvents: [], pendingInputs: [] } },
  }
})
afterEach(async () => { await act(async () => { root.unmount(); await new Promise((done) => setTimeout(done, 0)) }); container.remove(); vi.unstubAllGlobals() })
async function render() { await act(() => root.render(<SessionNavigation {...props} />)) }
function dialog() { return document.querySelector<HTMLElement>('[role="alertdialog"]') }
function confirm() { return [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '删除会话')! }
async function open(name = '当前对话') {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="删除 ${name}"]`)!
  await act(() => { button.focus(); button.dispatchEvent(new Event('pointerdown', { bubbles: true })); button.click() })
  return button
}
async function enter(button: HTMLButtonElement, repeat = false) { await act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat, bubbles: true, cancelable: true }))) }

it('shows a separate hover/focus delete action, including on the selected idle session', async () => {
  await render()
  const button = await open()
  expect(button.disabled).toBe(false)
  expect(button.className).toContain('group-hover/session:opacity-100')
  expect(button.className).toContain('group-focus-within/session:opacity-100')
  expect(button.className).toContain('group-data-[menu-open=true]/session:opacity-100')
  expect(button.className).toContain('[@media(hover:none)]:opacity-100')
  expect(button.parentElement?.querySelectorAll('button')).toHaveLength(2)
  expect(dialog()?.textContent).toContain('当前对话')
  expect(props.onSelect).not.toHaveBeenCalled()
  expect(props.onSessionOrderChange).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(confirm())
  await enter(confirm())
  expect(props.onDelete).toHaveBeenCalledExactlyOnceWith('one')
  expect(dialog()).toBeNull()
  await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  expect(document.activeElement).toBe(button)
})

it('supports cancelling with Escape or the cancel button without deleting', async () => {
  await render()
  await open('另一会话')
  await act(() => confirm().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(dialog()).toBeNull()
  await open('另一会话')
  await act(() => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '取消')!.click())
  expect(dialog()).toBeNull()
  expect(props.onDelete).not.toHaveBeenCalled()
  expect(props.onSelect).not.toHaveBeenCalled()
})

it('sends only one deletion while Enter is held or a request is pending', async () => {
  let finish!: () => void
  props.onDelete = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  await render()
  await open()
  const button = confirm()
  await enter(button, true)
  expect(props.onDelete).not.toHaveBeenCalled()
  await enter(button)
  await enter(button)
  await act(() => button.click())
  expect(props.onDelete).toHaveBeenCalledTimes(1)
  expect(button.disabled).toBe(true)
  await act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(dialog()).not.toBeNull()
  await act(() => finish())
  expect(dialog()).toBeNull()
})

it('keeps the confirmation open after failure and permits a retry', async () => {
  props.onDelete = vi.fn().mockRejectedValueOnce(new Error('failure')).mockResolvedValueOnce(undefined)
  await render()
  await open()
  await enter(confirm())
  expect(dialog()?.textContent).toContain('删除失败')
  expect(confirm().disabled).toBe(false)
  await enter(confirm())
  expect(props.onDelete).toHaveBeenCalledTimes(2)
  expect(dialog()).toBeNull()
})

it('disables deletion during a run, including a run starting after the confirmation opens', async () => {
  await render()
  const runningDelete = container.querySelector<HTMLButtonElement>('[aria-label="删除 运行中的会话"]')!
  expect(runningDelete.disabled).toBe(true)
  expect(runningDelete.className.split(' ')).toContain('disabled:opacity-0')
  expect(runningDelete.className.split(' ')).not.toContain('disabled:opacity-50')
  expect(runningDelete.className).toContain('group-hover/session:disabled:opacity-50')
  await open()
  props = { ...props, runs: { ...props.runs, one: { status: 'running', turns: [], systemEvents: [], pendingInputs: [] } } }
  await render()
  expect(confirm().disabled).toBe(true)
  await enter(confirm())
  expect(props.onDelete).not.toHaveBeenCalled()
})
