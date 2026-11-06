// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceLayout } from './workspace-layout.js'
import { NavigationToggle } from './navigation-toggle.js'
import { useWorkspaceStore } from './workspace-store.js'

let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
let gridWidth = 1472
const measurements = new Set<() => void>()
function View() {
  const ref = useRef<HTMLDivElement>(null)
  const collapsed = useWorkspaceStore((state) => state.navigationCollapsed)
  const toggle = () => useWorkspaceStore.getState().setNavigationCollapsed(!collapsed)
  return <WorkspaceLayout title="test" navigation={<div><input aria-label="导航搜索" defaultValue="保留查询" /><NavigationToggle controls="workspace-navigation" expanded={!collapsed} onToggle={toggle} /></div>} preview={<aside>文件预览</aside>} previewOpen containerRef={ref}><section>{collapsed && <span data-navigation-restore><NavigationToggle controls="workspace-navigation" expanded={false} onToggle={toggle} /></span>}聊天</section></WorkspaceLayout>
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe() { measurements.add(this.callback) }
    unobserve() { measurements.delete(this.callback) }
    disconnect() { measurements.delete(this.callback) }
  })
  gridWidth = 1472
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, top: 0, left: 0, right: gridWidth, bottom: 800, width: gridWidth, height: 800 } as DOMRect))
  useWorkspaceStore.setState({ navigationWidth: 272, navigationOpen: false, navigationCollapsed: false })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  useWorkspaceStore.getState().setNavigationWidth(272)
  useWorkspaceStore.getState().setNavigationCollapsed(false)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('applies navigation resizing to the grid and restores the preference after a temporary narrow window', async () => {
  await act(() => root.render(<View />))
  const grid = container.querySelector<HTMLElement>('.workspace-grid')!
  expect(grid.style.getPropertyValue('--navigation-width')).toBe('272px')
  expect(container.querySelector('[aria-label="调整会话导航宽度"]')?.parentElement?.classList.contains('md:block')).toBe(true)
  await act(() => useWorkspaceStore.getState().setNavigationWidth(480))
  expect(grid.style.getPropertyValue('--navigation-width')).toBe('480px')
  gridWidth = 768
  await act(() => measurements.forEach((measure) => measure()))
  expect(grid.style.getPropertyValue('--navigation-width')).toBe('408px')
  expect(useWorkspaceStore.getState().navigationWidth).toBe(480)
  gridWidth = 1472
  await act(() => measurements.forEach((measure) => measure()))
  expect(grid.style.getPropertyValue('--navigation-width')).toBe('480px')
})

it('persists and rehydrates navigation width while clamping invalid input', async () => {
  const store = useWorkspaceStore.getState()
  store.setNavigationWidth(420)
  const { storage, name } = useWorkspaceStore.persist.getOptions()
  const saved = await storage!.getItem(name!)
  expect(saved?.state).toMatchObject({ navigationWidth: 420 })
  store.setNavigationWidth(272)
  await storage!.setItem(name!, saved!)
  await useWorkspaceStore.persist.rehydrate()
  expect(useWorkspaceStore.getState().navigationWidth).toBe(420)
  for (const [input, expected] of [[-1, 220], [900, 480], [NaN, 272]]) {
    store.setNavigationWidth(input!)
    expect(useWorkspaceStore.getState().navigationWidth).toBe(expected)
  }
})

it('collapses the desktop column without unmounting navigation or losing its preferred width', async () => {
  await act(() => root.render(<View />))
  const grid = container.querySelector<HTMLElement>('.workspace-grid')!
  const search = container.querySelector<HTMLInputElement>('[aria-label="导航搜索"]')!
  search.value = '未完成的搜索'
  await act(() => useWorkspaceStore.setState({ navigationCollapsed: true }))
  expect(grid.style.getPropertyValue('--navigation-width')).toBe('0px')
  expect(container.querySelector('[aria-label="调整会话导航宽度"]')).toBeNull()
  expect(search.closest('aside')?.inert).toBe(true)
  await act(() => useWorkspaceStore.setState({ navigationCollapsed: false }))
  expect(grid.style.getPropertyValue('--navigation-width')).toBe('272px')
  expect(container.querySelector('[aria-label="导航搜索"]')).toBe(search)
  expect(search.value).toBe('未完成的搜索')
  expect(search.closest('aside')?.inert).toBe(false)
  expect(useWorkspaceStore.getState().navigationWidth).toBe(272)
})

it('persists desktop collapse independently of the mobile drawer', async () => {
  const store = useWorkspaceStore.getState()
  store.setNavigationCollapsed(true)
  store.setNavigationOpen(true)
  const { storage, name } = useWorkspaceStore.persist.getOptions()
  const saved = await storage!.getItem(name!)
  expect(saved?.state).toMatchObject({ navigationCollapsed: true })
  expect(saved?.state).not.toHaveProperty('navigationOpen')
  store.setNavigationCollapsed(false)
  await storage!.setItem(name!, saved!)
  await useWorkspaceStore.persist.rehydrate()
  expect(useWorkspaceStore.getState().navigationCollapsed).toBe(true)
})

it('moves keyboard focus between the collapse button and the restore entry', async () => {
  await act(() => root.render(<View />))
  const collapse = container.querySelector<HTMLButtonElement>('#workspace-navigation button[aria-controls="workspace-navigation"]')!
  await act(() => { collapse.focus(); collapse.click() })
  const restore = container.querySelector<HTMLButtonElement>('[data-navigation-restore] button')!
  expect(document.activeElement).toBe(restore)
  expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
  await act(() => restore.click())
  expect(document.activeElement).toBe(collapse)
  expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
})
