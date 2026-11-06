// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectVisibilityMigration } from './project-visibility-migration.js'
import { useWorkspaceStore } from './workspace-store.js'
import { fetchProjectMigration, migrateProjectVisibility } from './workspace-api.js'

vi.mock('./workspace-api.js', () => ({ fetchProjectMigration: vi.fn(), migrateProjectVisibility: vi.fn() }))
let root: Root
let element: HTMLDivElement
let client: QueryClient
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  vi.mocked(fetchProjectMigration).mockResolvedValue({ pending: true })
  vi.mocked(migrateProjectVisibility).mockResolvedValue(undefined)
  useWorkspaceStore.setState({ legacyHiddenProjectCwds: { '/old': true } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
afterEach(async () => { await act(() => root.unmount()); client.clear(); element.remove(); useWorkspaceStore.getState().clearLegacyProjectVisibility(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function mount() {
  await act(() => root.render(<QueryClientProvider client={client}><ProjectVisibilityMigration /></QueryClientProvider>))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
}
it('automatically removes legacy hidden projects without rendering a notice or buttons', async () => {
  client.setQueryData(['projects'], [{ id: 'cached' }])
  await mount()
  expect(migrateProjectVisibility).toHaveBeenCalledExactlyOnceWith(['/old'])
  expect(element.innerHTML).toBe('')
  expect(useWorkspaceStore.getState().legacyHiddenProjectCwds).toEqual({})
  expect(client.getQueryState(['projects'])?.isInvalidated).toBe(true)
})
it('retains legacy input after a failure and retries silently', async () => {
  vi.mocked(migrateProjectVisibility).mockRejectedValueOnce(new Error('迁移失败'))
  vi.useFakeTimers()
  await act(() => root.render(<QueryClientProvider client={client}><ProjectVisibilityMigration /></QueryClientProvider>))
  await act(() => vi.advanceTimersByTimeAsync(10))
  expect(element.innerHTML).toBe('')
  expect(useWorkspaceStore.getState().legacyHiddenProjectCwds).toEqual({ '/old': true })
  expect(migrateProjectVisibility).toHaveBeenCalledTimes(1)
  await act(() => vi.advanceTimersByTimeAsync(30_000))
  expect(migrateProjectVisibility).toHaveBeenLastCalledWith(['/old'])
  expect(migrateProjectVisibility).toHaveBeenCalledTimes(2)
  await act(() => vi.advanceTimersByTimeAsync(10))
  expect(useWorkspaceStore.getState().legacyHiddenProjectCwds).toEqual({})
})
it('discards obsolete local visibility when another browser already migrated', async () => {
  vi.mocked(fetchProjectMigration).mockResolvedValue({ pending: false })
  await mount()
  expect(element.innerHTML).toBe('')
  expect(migrateProjectVisibility).not.toHaveBeenCalled()
  expect(useWorkspaceStore.getState().legacyHiddenProjectCwds).toEqual({})
})
it('does not request migration when no legacy visibility remains', async () => {
  useWorkspaceStore.getState().clearLegacyProjectVisibility()
  await mount()
  expect(fetchProjectMigration).not.toHaveBeenCalled()
  expect(migrateProjectVisibility).not.toHaveBeenCalled()
})
