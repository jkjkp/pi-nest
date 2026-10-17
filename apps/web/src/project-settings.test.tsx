// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsPage } from './settings-page.js'
import { useWorkspaceStore } from './workspace-store.js'
import { fetchPiConfiguration } from './workspace-api.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), fetchPiConfiguration: vi.fn() }))
let container: HTMLDivElement
let root: Root
let router: ReturnType<typeof createMemoryRouter>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(fetchPiConfiguration).mockReset().mockRejectedValue(new Error('Pi 配置损坏'))
  useWorkspaceStore.setState({ hiddenProjectCwds: { '/work/one': true, '/work/no-longer-in-session-list': true } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); router.dispose(); container.remove(); vi.unstubAllGlobals() })
async function mount(path: string) {
  router = createMemoryRouter([{ path: '/settings/:category?', element: <SettingsPage /> }], { initialEntries: [path] })
  await act(() => root.render(<RouterProvider router={router} />))
}

it('restores removed projects without loading Pi configuration or requiring session metadata', async () => {
  await mount('/settings/projects')
  expect(fetchPiConfiguration).not.toHaveBeenCalled()
  expect(container.textContent).toContain('已移除项目（2）')
  expect(container.textContent).toContain('/work/no-longer-in-session-list')
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="恢复 one"]')!.click())
  expect(useWorkspaceStore.getState().hiddenProjectCwds).toEqual({ '/work/no-longer-in-session-list': true })
  expect(container.textContent).toContain('已移除项目（1）')
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="恢复 no-longer-in-session-list"]')!.click())
  expect(container.textContent).toContain('没有已移除项目')
})

it('keeps project recovery available after another settings category fails to load', async () => {
  await mount('/settings/models')
  expect(container.textContent).toContain('Pi 配置损坏')
  await act(() => router.navigate('/settings/projects'))
  expect(container.textContent).not.toContain('Pi 配置损坏')
  expect(container.textContent).not.toContain('正在读取 Pi 配置')
  expect(container.textContent).toContain('已移除项目（2）')
  expect(fetchPiConfiguration).toHaveBeenCalledTimes(1)
})
