// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { ProjectFilesTree } from './project-files-tree.js'
import { useWorkspaceStore } from './workspace-store.js'
import { listWorkspaceFiles, watchWorkspaceFiles } from './workspace-files-api.js'
vi.mock('./workspace-files-api.js', () => ({
  listWorkspaceFiles: vi.fn(async (_scope, path, offset) => ({ root: '/project', path, entries: path ? [{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }] : offset ? [{ name: 'last.txt', path: 'last.txt', kind: 'file' }] : [{ name: 'src', path: 'src', kind: 'directory' }, { name: 'fs-rules.yaml', path: 'fs-rules.yaml', kind: 'file' }], nextOffset: !path && !offset ? 200 : undefined })),
  watchWorkspaceFiles: vi.fn(() => new Promise(() => undefined)),
}))
it('lazily expands folders, pages files, opens YAML, and aborts its subscription on close', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useWorkspaceStore.setState({ filePreviews: {} })
  useWorkspaceStore.getState().setFilePreviewOpen('draft', true)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); const open = vi.fn()
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }) }
  const click = async (name: string) => { const button = [...host.querySelectorAll('button')].find(button => button.textContent === name)!; expect(button).toBeDefined(); await act(() => button.click()); await settle() }
  try {
    await act(() => root.render(<QueryClientProvider client={client}><ProjectFilesTree scope={{ kind: 'project', cwd: '/project' }} scopeKey="draft" cwd="/project" onOpenFile={open} /></QueryClientProvider>))
    await settle()
    expect(listWorkspaceFiles).toHaveBeenCalledTimes(1)
    await click('fs-rules.yaml'); expect(open).toHaveBeenCalledWith('fs-rules.yaml')
    await click('src'); expect(host.textContent).toContain('a.ts')
    await click('加载更多'); expect(host.textContent).toContain('last.txt')
    const signal = vi.mocked(watchWorkspaceFiles).mock.calls.at(-1)![2]
    await act(() => root.unmount())
    expect(signal.aborted).toBe(true)
  } finally { await act(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals() }
})
