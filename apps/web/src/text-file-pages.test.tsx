// @vitest-environment happy-dom
import { act, useEffect, StrictMode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TextFilePage } from '@pi-nest/contracts'
import { SessionFilePreview } from './session-file-preview.js'
import { useTextFilePages } from './use-text-file-pages.js'
import { useWorkspaceStore } from './workspace-store.js'
import { filePreviewKey, restoreFilePositions } from './file-preview-state.js'
import { fetchTextFilePage, fetchTextFileStat } from './text-file-api.js'
vi.mock('./text-file-api.js', () => ({ fetchTextFilePage: vi.fn(), fetchTextFileStat: vi.fn() }))
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let client: QueryClient
const source = { sessionId: 'session', path: 'large.log' }
const key = filePreviewKey(source.sessionId, source.path)
const page = (offset: number, version = '1', eof = false): TextFilePage => ({ kind: 'page', path: source.path, version, fileBytes: 100 * 1024 * 1024, cursor: { offset, line: offset / 262144 + 1, midLine: offset > 0, version }, text: `${offset}:` + 'a'.repeat(262100), startsMidLine: offset > 0, endsMidLine: !eof, endOffset: offset + 262144, lastLine: offset / 262144 + 1, eof, nextCursor: eof ? undefined : { offset: offset + 262144, line: offset / 262144 + 2, midLine: true, version } })
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useWorkspaceStore.setState({ fileReadingPositions: {} })
  vi.mocked(fetchTextFileStat).mockResolvedValue({ path: source.path, version: '1', fileBytes: 100 * 1024 * 1024 })
  vi.mocked(fetchTextFilePage).mockImplementation(async (_source, request) => page(request.direction === 'previous' ? request.cursor!.offset - 262144 : request.cursor?.offset ?? 0))
})
afterEach(async () => { await act(() => root.unmount()); client.clear(); host.remove(); vi.resetAllMocks(); vi.unstubAllGlobals() })
async function render(path = source.path, line?: number) { await act(() => root.render(<QueryClientProvider client={client}><SessionFilePreview sessionId={source.sessionId} path={path} line={line} navigation={0} onClose={() => undefined} /></QueryClientProvider>)); await settle() }
async function click(label: string) { const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`) ?? [...host.querySelectorAll('button')].find(button => button.textContent === label)!; expect(button).toBeDefined(); await act(() => button.click()); await settle() }
it('opens a 100 MiB file as a bounded source window and preserves it on version conflict', async () => {
  await render()
  expect(fetchTextFilePage).toHaveBeenCalledTimes(1)
  expect(host.querySelector('pre')?.textContent?.length).toBeLessThan(263000)
  expect(host.textContent).toContain('超长行片段')
  vi.mocked(fetchTextFilePage).mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'FILE_VERSION_CHANGED' }))
  await click('下一片段')
  expect(host.textContent).toContain('文件已更新')
  expect(host.querySelector('pre')?.textContent).toContain('0:')
  expect(host.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')?.disabled).toBe(false)
})
it('loads and retries later pages without discarding already displayed content', async () => {
  await render()
  vi.mocked(fetchTextFilePage).mockRejectedValueOnce(new Error('temporary'))
  await click('下一片段')
  expect(host.textContent).toContain('temporary')
  await click('重试读取')
  expect(host.querySelector('pre')?.textContent).toContain('262144:')
  await click('上一片段')
  expect(host.querySelector('pre')?.textContent).toContain('0:')
})
it('keeps large Markdown in source mode and never renders a partial document', async () => {
  await render('large.md')
  expect(host.textContent).toContain('文件较大，已使用分页源码预览')
  expect(host.querySelector('[aria-label="Markdown 阅读"]')).toBeNull()
})
it('continues a cancellable seek in batches and ignores a late result after changing files', async () => {
  let finish: (result: TextFilePage) => void = () => undefined
  let oldSignal: AbortSignal | undefined
  vi.mocked(fetchTextFilePage).mockImplementation(async (source, request, signal) => {
    if (source.path !== 'large.log') return { ...page(0), text: 'new file' }
    if (!request.cursor) return { kind: 'seeking', path: source.path, fileBytes: 100_000_000, version: '1', cursor: { offset: 8_388_608, line: 1000, midLine: false, version: '1' } }
    oldSignal = signal
    return new Promise(resolve => { finish = resolve })
  })
  await render('large.log', 50_000)
  expect(host.textContent).toContain('正在定位')
  await render('new.log')
  expect(oldSignal?.aborted).toBe(true)
  await act(async () => finish({ ...page(0), text: 'late old file' }))
  expect(host.textContent).toContain('new file')
  expect(host.textContent).not.toContain('late old file')
})
it('bounds the page cache, rereads evicted content, and persists cursor metadata only', async () => {
  let view: ReturnType<typeof useTextFilePages>
  function Probe() { const current = useTextFilePages(source, key, undefined, 0); useEffect(() => { view = current }, [current]); return <span>{current.page?.cursor.offset}</span> }
  await act(() => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>)); await settle()
  for (let i = 0; i < 12; i++) { await act(() => view!.next()); await settle() }
  expect(fetchTextFilePage).toHaveBeenCalledTimes(13)
  const calls = vi.mocked(fetchTextFilePage).mock.calls.length
  for (let i = 0; i < 12; i++) { await act(() => view!.previous()); await settle() }
  expect(vi.mocked(fetchTextFilePage).mock.calls.length).toBeGreaterThan(calls)
  expect(view!.page?.cursor.offset).toBe(0)
  const position = useWorkspaceStore.getState().fileReadingPositions[key]!
  expect(position.pageCursor?.offset).toBe(0)
  expect(restoreFilePositions({ [key]: { ...position, content: 'private text', pageCursor: { ...position.pageCursor, text: 'private text' } } })[key]).not.toHaveProperty('content')
  expect(restoreFilePositions({ [key]: position })[key]?.pageCursor).not.toHaveProperty('text')
  const signal = vi.mocked(fetchTextFilePage).mock.calls.at(-1)![2]
  await act(() => root.unmount())
  expect(signal.aborted).toBe(true)
  await settle()
  expect(client.getQueryCache().getAll()).toHaveLength(0)
})

it('re-navigates an already open file even when the old window records the new navigation revision', async () => {
  await render()
  vi.mocked(fetchTextFilePage).mockImplementation(async (_source, request) => request.targetLine ? { ...page(90_000_000), cursor: { offset: 90_000_000, line: request.targetLine, midLine: false, version: '1' }, text: 'target row\n'.repeat(100), lastLine: request.targetLine + 99 } : page(0))
  await act(() => root.render(<QueryClientProvider client={client}><SessionFilePreview sessionId={source.sessionId} path={source.path} line={3_000_000} navigation={1} onClose={() => undefined} /></QueryClientProvider>)); await settle()
  expect(vi.mocked(fetchTextFilePage).mock.calls.at(-1)?.[1]).toMatchObject({ targetLine: 2_999_960 })
  expect(host.querySelector('.bg-accent')?.textContent).toContain('3000000')
})

it('recovers an obsolete restored cursor by seeking in the new version', async () => {
  useWorkspaceStore.getState().rememberFilePosition(key, { start: 0, scrollTop: 0, scrollLeft: 0, mode: 'source', zoom: 'fit', navigation: 0, pageCursor: { offset: 262144, line: 2, midLine: true, version: 'old' } })
  vi.mocked(fetchTextFilePage).mockImplementation(async (_source, request) => {
    if (request.cursor?.version === 'old') throw Object.assign(new Error('obsolete cursor'), { code: 'FILE_VERSION_CHANGED' })
    return { ...page(0), text: 'fresh version' }
  })
  await render()
  expect(host.textContent).toContain('文件已更新')
  await click('刷新文件')
  expect(host.querySelector('pre')?.textContent).toContain('fresh version')
  expect(vi.mocked(fetchTextFilePage).mock.calls.at(-1)?.[1]).toEqual({ targetLine: 2 })
})

it('keeps the latest navigation when two revisions commit before queued reads start', async () => {
  await render()
  vi.mocked(fetchTextFilePage).mockImplementation(async (_source, request) => ({ ...page(90_000_000), cursor: { offset: 90_000_000, line: request.targetLine!, midLine: false, version: '1' }, text: 'target row\n'.repeat(100), lastLine: request.targetLine! + 99 }))
  const view = (line: number, navigation: number) => <QueryClientProvider client={client}><SessionFilePreview sessionId={source.sessionId} path={source.path} line={line} navigation={navigation} onClose={() => undefined} /></QueryClientProvider>
  await act(async () => { flushSync(() => root.render(view(1000, 1))); flushSync(() => root.render(view(2000, 2))) })
  await settle()
  expect(vi.mocked(fetchTextFilePage).mock.calls.at(-1)?.[1]).toMatchObject({ targetLine: 1960 })
  expect(host.querySelector('.bg-accent')?.textContent).toContain('2000')
})
it('starts only the current historical read through StrictMode effect replay', async () => {
  vi.mocked(fetchTextFilePage).mockImplementation(async (_source, request) => ({ ...page(10000), cursor: { offset: 10000, line: request.targetLine!, midLine: false, version: '1' }, text: 'target row\n'.repeat(100), lastLine: request.targetLine! + 99 }))
  await act(() => root.render(<StrictMode><QueryClientProvider client={client}><SessionFilePreview sessionId={source.sessionId} path={source.path} line={500} navigation={1} onClose={() => undefined} /></QueryClientProvider></StrictMode>)); await settle()
  expect(fetchTextFilePage).toHaveBeenCalledTimes(1)
  expect(host.querySelector('.bg-accent')?.textContent).toContain('500')
})
