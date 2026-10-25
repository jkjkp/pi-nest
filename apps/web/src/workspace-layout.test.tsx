// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceLayout } from './workspace-layout.js'
import { useWorkspaceStore } from './workspace-store.js'

let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
let gridWidth = 1472
const measurements = new Set<() => void>()
function View() {
  const ref = useRef<HTMLDivElement>(null)
  return <WorkspaceLayout title="test" navigation={<span>项目</span>} preview={<aside>文件预览</aside>} previewOpen containerRef={ref}><section>聊天</section></WorkspaceLayout>
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe() { measurements.add(this.callback) }
    disconnect() { measurements.delete(this.callback) }
  })
  gridWidth = 1472
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: gridWidth } as DOMRect))
  useWorkspaceStore.setState({ navigationWidth: 272, navigationOpen: false })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  useWorkspaceStore.getState().setNavigationWidth(272)
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
