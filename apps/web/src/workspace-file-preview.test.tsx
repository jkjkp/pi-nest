// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceLayout } from './workspace-layout.js'
import { WorkspaceFilePreview, WorkspaceFilePreviewToggle } from './workspace-file-preview.js'
import { useWorkspaceFilePreview } from './use-workspace-file-preview.js'
import { useWorkspaceStore } from './workspace-store.js'

vi.mock('./project-files-tree.js', () => ({ ProjectFilesTree: () => <section aria-label="项目文件树">项目文件树</section> }))
vi.mock('./session-file-preview.js', () => ({ SessionFilePreview: ({ path, onClose }: { path: string; onClose: () => void }) => <section aria-label="当前文件预览"><p>{path}</p><button onClick={onClose}>收起预览</button></section> }))
let root: Root
let container: HTMLDivElement
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }
const listeners = new Set<() => void>()
const before = vi.fn()
const after = vi.fn()
function View({ sessionId = 'a' }: { sessionId?: string }) {
  const grid = useRef<HTMLDivElement>(null)
  const preview = useWorkspaceFilePreview(sessionId, before, after)
  return <WorkspaceLayout title={sessionId} navigation={<span>navigation</span>} previewOpen={preview.open} containerRef={grid} preview={<WorkspaceFilePreview preview={preview} containerRef={grid} />}>
    <section><button onClick={() => preview.openFile(`${sessionId}.ts`, 12)}>查看文件</button><WorkspaceFilePreviewToggle open={preview.open} onToggle={preview.toggle} buttonRef={preview.toggleRef} /></section>
  </WorkspaceLayout>
}
async function render(sessionId = 'a') { await act(() => root.render(<View sessionId={sessionId} />)) }
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === text)!
  button.focus()
  await act(() => button.click())
  return button
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  before.mockClear(); after.mockClear(); listeners.clear()
  media = { matches: true, addEventListener: vi.fn((_type, listener) => listeners.add(listener)), removeEventListener: vi.fn((_type, listener) => listeners.delete(listener)) }
  vi.spyOn(window, 'matchMedia').mockImplementation(() => media as unknown as MediaQueryList)
  useWorkspaceStore.setState({ filePreviews: {}, inspectorWidth: 420, navigationOpen: false })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps preview selection scoped to its session and restores the file opener on desktop close', async () => {
  await render()
  const opener = await click('查看文件')
  expect(document.querySelectorAll('[aria-label="当前文件预览"]')).toHaveLength(1)
  expect(useWorkspaceStore.getState().filePreviews.a).toMatchObject({ tabs: [{ path: 'a.ts', line: 12 }], open: true })
  await click('收起预览')
  expect(document.activeElement).toBe(opener)
  expect(useWorkspaceStore.getState().filePreviews.a?.open).toBe(false)
  await render('b')
  await click('查看文件')
  expect(document.querySelector('[aria-label="当前文件预览"]')?.textContent).toContain('b.ts')
  await render('a')
  expect(document.querySelector('[aria-label="当前文件预览"]')).toBeNull()
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="打开文件预览"]')!
  await act(() => toggle.click())
  expect(before).toHaveBeenCalledTimes(4)
  expect(document.querySelector('[aria-label="当前文件预览"]')?.textContent).toContain('a.ts')
  expect(useWorkspaceStore.getState().filePreviews.b?.open).toBe(true)
})

it('moves between desktop and modal presentation without duplicating content or changing the saved width', async () => {
  await render()
  await click('查看文件')
  for (const wide of [false, true, false]) {
    await act(() => { media.matches = wide; listeners.forEach((listener) => listener()) })
    expect(document.querySelectorAll('[aria-label="当前文件预览"]')).toHaveLength(1)
    expect(document.querySelector('[role="dialog"]') !== null).toBe(!wide)
    expect(useWorkspaceStore.getState().inspectorWidth).toBe(420)
    expect(useWorkspaceStore.getState().filePreviews.a?.open).toBe(true)
  }
  await click('收起预览')
  expect(useWorkspaceStore.getState().filePreviews.a?.open).toBe(false)
  await act(() => root.render(null))
  expect(media.removeEventListener).toHaveBeenCalled()
  expect(listeners.size).toBe(0)
})

 it('always shows the borderless toggle and opens files without selecting a file first', async () => {
   await render()
   const toggle = container.querySelector<HTMLButtonElement>('[aria-label="打开文件预览"]')!
   expect(toggle).not.toBeNull()
   await act(() => toggle.click())
   expect(document.querySelector('[aria-label="项目文件树"]')).not.toBeNull()
   expect(useWorkspaceStore.getState().filePreviews.a).toMatchObject({ open: true, tabs: [] })
 })
