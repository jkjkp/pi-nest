// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsPage } from './settings-page.js'
import { useWorkspaceStore } from './workspace-store.js'
import { fetchPiConfiguration, fetchRemovedProjects, restoreProject } from './workspace-api.js'
import { fixtureProject } from './test-fixtures/workspace.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), fetchPiConfiguration: vi.fn(), fetchRemovedProjects: vi.fn(), restoreProject: vi.fn() }))
let container: HTMLDivElement
let root: Root
let client: QueryClient
let router: ReturnType<typeof createMemoryRouter>
let removed = [fixtureProject('/work/one'), fixtureProject('/work/no-longer-in-session-list')]
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(fetchPiConfiguration).mockReset().mockRejectedValue(new Error('Pi 配置损坏'))
  removed = [fixtureProject('/work/one'), fixtureProject('/work/no-longer-in-session-list')]
  vi.mocked(fetchRemovedProjects).mockReset().mockImplementation(async () => removed)
  vi.mocked(restoreProject).mockReset().mockImplementation(async (id) => { removed = removed.filter((project) => project.id !== id) })
  useWorkspaceStore.setState({ legacyHiddenProjectCwds: {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); router.dispose(); client.clear(); container.remove(); vi.unstubAllGlobals() })
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) }) }
async function mount(path: string) {
  router = createMemoryRouter([{ path: '/settings/:category?', element: <SettingsPage /> }], { initialEntries: [path] })
  await act(() => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>))
  await settle()
}

it('loads and restores server projects without configuration or session metadata', async () => {
  await mount('/settings/projects')
  expect(fetchPiConfiguration).not.toHaveBeenCalled()
  expect(container.textContent).toContain('已移除项目（2）')
  expect(container.textContent).toContain('/work/no-longer-in-session-list')
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="恢复 one"]')!.click())
  await settle()
  expect(restoreProject).toHaveBeenCalledExactlyOnceWith('/work/one')
  expect(container.textContent).toContain('已移除项目（1）')
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="恢复 no-longer-in-session-list"]')!.click())
  await settle()
  expect(container.textContent).toContain('没有已移除项目')
})

it('keeps project recovery available after another category fails', async () => {
  await mount('/settings/models')
  expect(container.textContent).toContain('Pi 配置损坏')
  await act(() => router.navigate('/settings/projects'))
  await settle()
  expect(container.textContent).not.toContain('Pi 配置损坏')
  expect(container.textContent).toContain('已移除项目（2）')
  expect(fetchPiConfiguration).toHaveBeenCalledTimes(1)
})

it('retains the project after a failed restore and permits retry', async () => {
  vi.mocked(restoreProject).mockRejectedValueOnce(new Error('数据库暂时不可用'))
  await mount('/settings/projects')
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="恢复 one"]')!.click())
  await settle()
  expect(container.textContent).toContain('数据库暂时不可用')
  expect(container.textContent).toContain('已移除项目（2）')
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="恢复 one"]')!.click())
  await settle()
  expect(container.textContent).toContain('已移除项目（1）')
})
