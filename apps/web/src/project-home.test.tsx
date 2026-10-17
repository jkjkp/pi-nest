// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspacePage } from './workspace-page.js'
import { useWorkspaceStore } from './workspace-store.js'
import type { SessionRunController } from './session-run-controller.js'
import { addProject, createSession } from './workspace-api.js'
import { sessionHistoryQueryKey } from './history.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), addProject: vi.fn(), createSession: vi.fn(), fetchSessionHistory: vi.fn(async (id: string) => ({ session: { id }, entries: [], hasEarlier: false, revision: 'fixture' })), fetchSessionTurnIndex: vi.fn(async () => ({ entries: [], revision: 'fixture' })) }))
let container: HTMLDivElement
let root: Root
let client: QueryClient
const native = { id: 'old', name: '已有对话', cwd: '/existing' }
const controller = { openSession: vi.fn(), releaseForeground: vi.fn(), getCommands: vi.fn(async () => []), adopt: vi.fn() } as unknown as SessionRunController
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
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
