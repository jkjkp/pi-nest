// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspacePage } from './workspace-page.js'
import { useWorkspaceStore } from './workspace-store.js'
import type { SessionRunController } from './session-run-controller.js'
import { addProject, createSession, selectProjectFolder } from './workspace-api.js'
import { sessionHistoryQueryKey } from './history.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), addProject: vi.fn(), selectProjectFolder: vi.fn(), createSession: vi.fn(), fetchSessionHistory: vi.fn(async (id: string) => ({ session: { id }, entries: [], hasEarlier: false, revision: 'fixture' })), fetchSessionTurnIndex: vi.fn(async () => ({ entries: [], revision: 'fixture' })) }))
let container: HTMLDivElement
let root: Root
let client: QueryClient
const native = { id: 'old', name: '已有对话', cwd: '/existing' }
const controller = { openSession: vi.fn(), releaseForeground: vi.fn(), getCommands: vi.fn(async () => []), adopt: vi.fn() } as unknown as SessionRunController
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  vi.mocked(selectProjectFolder).mockReset().mockResolvedValue(null)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['sessions'], [native])
  client.setQueryData(['projects'], [])
  client.setQueryData(sessionHistoryQueryKey('old'), { pages: [{ session: native, entries: [], hasEarlier: false, revision: 'fixture' }], pageParams: [{}] })
  useWorkspaceStore.setState({ runs: {}, drafts: {}, hiddenProjectCwds: {}, collapsedProjectKeys: {}, navigationOrder: { projectOrder: [], sessionOrderByProject: {} }, watchStates: {}, runtimeStates: {}, runtimeDetails: {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function Location() { const location = useLocation(); return <output data-route>{location.pathname}{location.search}</output> }
async function mount(path = '/') { await act(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><WorkspacePage sessionRuns={controller} /><Location /></MemoryRouter></QueryClientProvider>)) }
async function click(label: string) { await act(() => [...document.querySelectorAll('button')].find((node) => node.textContent === label)!.click()) }
async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('keeps the root on the project home even when historical conversations exist', async () => {
  await mount()
  expect(container.querySelector('[data-route]')?.textContent).toBe('/')
  expect(container.textContent).toContain('从项目开始')
  expect(container.textContent).toContain('打开项目')
  expect(container.textContent).toContain('新建项目')
  expect(container.querySelector('textarea')).toBeNull()
  expect(controller.openSession).not.toHaveBeenCalled()
  await act(() => container.querySelector<HTMLButtonElement>('button[title="/existing"]')!.click())
  await click('已有对话')
  expect(container.querySelector('[data-route]')?.textContent).toBe('/?session=old')
  expect(container.querySelector('textarea')).not.toBeNull()
  expect(controller.openSession).toHaveBeenCalledWith('old')
})

it.each(['open', 'create'] as const)('adds an empty project via %s without creating a Pi session until the first message', async (kind) => {
  vi.mocked(addProject).mockResolvedValue({ cwd: '/projects/new-project', createdAt: '2026-10-17T00:00:00Z' })
  await mount()
  await click(kind === 'open' ? '打开项目' : '新建项目')
  const dialog = document.querySelector('[role="dialog"]')!
  const inputs = dialog.querySelectorAll<HTMLInputElement>('input')
  await fill(inputs[0]!, kind === 'open' ? '/projects/new-project' : '/projects')
  if (kind === 'create') await fill(inputs[1]!, 'new-project')
  await act(() => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(addProject).toHaveBeenCalledWith(kind === 'open' ? { kind, cwd: '/projects/new-project' } : { kind, parent: '/projects', name: 'new-project' })
  expect(container.querySelector('[data-route]')?.textContent).toBe('/?draftProject=cwd%3A%2Fprojects%2Fnew-project')
  expect(container.textContent).toContain('在 new-project 开始新对话')
  expect(createSession).not.toHaveBeenCalled()
  vi.mocked(createSession).mockResolvedValue({ id: 'new-session', cwd: '/projects/new-project' })
  await fill(container.querySelector<HTMLTextAreaElement>('textarea')!, 'first message')
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="发送提示词"]')!.click())
  expect(createSession).toHaveBeenCalledExactlyOnceWith('/projects/new-project', 'first message')
  expect(controller.adopt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'new-session', prompt: 'first message' }))
})

it('shows folder errors without navigating or adding a fake project', async () => {
  vi.mocked(addProject).mockRejectedValue(new Error('文件夹不存在，请检查路径。'))
  await mount()
  await click('打开项目')
  const dialog = document.querySelector('[role="dialog"]')!
  await fill(dialog.querySelector<HTMLInputElement>('input')!, '/missing')
  await act(() => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(dialog.textContent).toContain('文件夹不存在')
  expect(container.querySelector('[data-route]')?.textContent).toBe('/')
  expect(client.getQueryData(['projects'])).toEqual([])
})


it('cancels the project dialog without submitting or navigating', async () => {
  await mount()
  await click('打开项目')
  const dialog = document.querySelector('[role="dialog"]')!
  await fill(dialog.querySelector<HTMLInputElement>('input')!, '/existing')
  await click('取消')
  expect(addProject).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[data-route]')?.textContent).toBe('/')
})

it('creates a project from the sidebar source folder and restores a previously hidden project', async () => {
  const cwd = '/projects/new-project'
  useWorkspaceStore.setState({ hiddenProjectCwds: { [cwd]: true } })
  vi.mocked(addProject).mockResolvedValue({ cwd, createdAt: '2026-10-18T00:00:00Z' })
  await mount('/?session=old')
  expect(container.querySelector('a[href="/"]')).toBeNull()
  expect(container.textContent).not.toContain('已移除项目')
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="创建项目"]')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('源文件夹')
  expect(dialog.textContent).toContain('在此电脑上选择文件夹')
  expect(dialog.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true)
  vi.mocked(selectProjectFolder).mockResolvedValue( cwd)
  await click('选择文件夹')
  expect(dialog.textContent).toContain(cwd)
  expect(addProject).not.toHaveBeenCalled()
  await click('创建项目')
  expect(addProject).toHaveBeenCalledExactlyOnceWith({ kind: 'open', cwd })
  expect(useWorkspaceStore.getState().hiddenProjectCwds[cwd]).toBeUndefined()
  expect(container.querySelector('[data-route]')?.textContent).toBe('/?draftProject=cwd%3A%2Fprojects%2Fnew-project')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(createSession).not.toHaveBeenCalled()
})

it('only stages a source folder and discards it when removed or cancelled', async () => {
  await mount()
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="创建项目"]')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  vi.mocked(selectProjectFolder).mockResolvedValue( '/existing')
  await click('选择文件夹')
  await act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="移除源文件夹"]')!.click())
  expect(dialog.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true)
  await click('取消')
  expect(addProject).not.toHaveBeenCalled()
  expect(container.querySelector('[data-route]')?.textContent).toBe('/')
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="创建项目"]')!.click())
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('/existing')
})

it('preserves the chosen source and current conversation when project creation fails', async () => {
  vi.mocked(addProject).mockRejectedValue(new Error('文件夹不存在，请检查路径。'))
  await mount('/?session=old')
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="创建项目"]')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  vi.mocked(selectProjectFolder).mockResolvedValue( '/missing')
  await click('选择文件夹')
  await click('创建项目')
  expect(dialog.textContent).toContain('文件夹不存在')
  expect(dialog.textContent).toContain('/missing')
  expect(container.querySelector('[data-route]')?.textContent).toBe('/?session=old')
  expect(client.getQueryData(['projects'])).toEqual([])
})


it('replaces the single source using the native picker and submits only the final directory', async () => {
  vi.mocked(addProject).mockResolvedValue({ cwd: '/second', createdAt: '2026-10-18T00:00:00Z' })
  vi.mocked(selectProjectFolder).mockResolvedValueOnce('/first').mockResolvedValueOnce('/second')
  await mount()
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="创建项目"]')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  await click('选择文件夹')
  expect(dialog.querySelector('input')).toBeNull()
  expect(selectProjectFolder).toHaveBeenNthCalledWith(1, undefined)
  await click('重新选择')
  expect(selectProjectFolder).toHaveBeenNthCalledWith(2, '/first')
  expect(dialog.textContent).toContain('/second')
  expect(dialog.textContent).not.toContain('/first')
  expect(addProject).not.toHaveBeenCalled()
  await click('创建项目')
  expect(addProject).toHaveBeenCalledExactlyOnceWith({ kind: 'open', cwd: '/second' })
})

it('keeps the previous source when the native picker is cancelled and disables actions while it is open', async () => {
  vi.mocked(addProject).mockResolvedValue({ cwd: '/first', createdAt: '2026-10-18T00:00:00Z' })
  let finish!: (cwd: string | null) => void
  vi.mocked(selectProjectFolder).mockResolvedValueOnce('/first').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await mount()
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="创建项目"]')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  await click('选择文件夹')
  await click('重新选择')
  expect(dialog.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true)
  expect(dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.disabled).toBe(true)
  await act(() => finish(null))
  expect(dialog.textContent).toContain('/first')
  expect(addProject).not.toHaveBeenCalled()
  await click('创建项目')
  expect(addProject).toHaveBeenCalledExactlyOnceWith({ kind: 'open', cwd: '/first' })
})

it('handles native picker cancellation and failure without registering a project', async () => {
  vi.mocked(selectProjectFolder).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('无法打开系统文件夹选择器，请重试。'))
  await mount()
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="创建项目"]')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  await click('选择文件夹')
  expect(dialog.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true)
  await click('选择文件夹')
  expect(dialog.textContent).toContain('无法打开系统文件夹选择器')
  expect(addProject).not.toHaveBeenCalled()
  expect(container.querySelector('[data-route]')?.textContent).toBe('/')
})
