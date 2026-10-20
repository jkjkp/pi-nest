// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionFilePreview } from './session-file-preview.js'
import { useWorkspaceStore } from './workspace-store.js'
import { fetchSessionFilePreview, fetchSessionImagePreview } from './workspace-api.js'

vi.mock('./workspace-api.js', () => ({ fetchSessionFilePreview: vi.fn(), fetchSessionImagePreview: vi.fn() }))
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div')
document.body.append(container)
const root = createRoot(container)
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
afterEach(async () => { await act(async () => root.render(null)); queryClient.clear(); vi.mocked(fetchSessionFilePreview).mockReset(); vi.mocked(fetchSessionImagePreview).mockReset(); useWorkspaceStore.setState({ fileReadingPositions: {} }); vi.unstubAllGlobals() })

async function render(path: string, line?: number) {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SessionFilePreview key={path} sessionId="one" path={path} line={line} onClose={() => undefined} /></QueryClientProvider>))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

it('bounds large files to a line window and distinguishes current text from recorded results', async () => {
  vi.mocked(fetchSessionFilePreview).mockResolvedValue({ path: 'a.ts', content: Array.from({ length: 1500 }, (_, i) => `line ${i + 1}`).join('\n') })
  await render('a.ts', 800)
  expect(container.textContent).toContain('当前内容可能与历史调用不同')
  expect(container.querySelectorAll('pre > span')).toHaveLength(200)
  expect(container.querySelector('.bg-accent')?.textContent).toContain('line 800')
  expect(container.textContent).not.toContain('line 1line')
})

it('cancels a previous file request and never replaces the selected file with a late result', async () => {
  let finish: (value: { path: string; content: string }) => void = () => undefined
  let oldSignal: AbortSignal | undefined
  vi.mocked(fetchSessionFilePreview).mockImplementation((_session, path, signal) => {
    if (path === 'a.ts') { oldSignal = signal; return new Promise((resolve) => { finish = resolve }) }
    return Promise.resolve({ path, content: 'current file' })
  })
  await render('a.ts')
  await render('b.ts')
  expect(oldSignal?.aborted).toBe(true)
  await act(async () => { finish({ path: 'a.ts', content: 'stale file' }); await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(container.textContent).toContain('current file')
  expect(container.textContent).not.toContain('stale file')
})

it('shows a readable failure and clamps a removed historical line to the current file end', async () => {
  vi.mocked(fetchSessionFilePreview).mockRejectedValue(new Error('文件已删除或不存在。'))
  await render('missing')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('文件已删除或不存在。')
  vi.mocked(fetchSessionFilePreview).mockResolvedValue({ path: 'short.ts', content: 'one\ntwo' })
  await render('short.ts', 800)
  expect(container.textContent).toContain('原行号已超出当前文件')
  expect(container.querySelector('.bg-accent')?.textContent).toContain('two')
})

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((button) => button.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}

it('retains old text when refresh fails, then clamps the reading window after a successful shorter refresh', async () => {
  vi.mocked(fetchSessionFilePreview).mockResolvedValue({ path: 'refresh.ts', content: Array.from({ length: 700 }, (_, i) => `row ${i + 1}`).join('\n') })
  await render('refresh.ts')
  await click('后 200 行')
  const scroll = container.querySelector('[aria-label="文件文本"]')!
  await act(async () => { scroll.scrollTop = 100; scroll.dispatchEvent(new Event('scroll', { bubbles: true })) })
  vi.mocked(fetchSessionFilePreview).mockRejectedValueOnce(new Error('文件暂时无法访问。'))
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ['session-file-preview'] }) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('仍显示上次读取的内容')
  expect(container.querySelector('pre')?.textContent).toContain('row 201')
  vi.mocked(fetchSessionFilePreview).mockResolvedValueOnce({ path: 'refresh.ts', content: 'short' })
  await click('重试读取')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(container.querySelector('pre')?.textContent).toContain('short')
  expect(container.textContent).toContain('1–1 / 1')
})

it('restores reading position with fresh content on reopen, and relocates without another fetch', async () => {
  vi.mocked(fetchSessionFilePreview).mockResolvedValue({ path: 'read.ts', content: Array.from({ length: 1200 }, (_, i) => `row ${i + 1}`).join('\n') })
  await render('read.ts', 500)
  await click('后 200 行')
  const scroll = container.querySelector('[aria-label="文件文本"]')!
  await act(async () => { scroll.scrollTop = 75; scroll.dispatchEvent(new Event('scroll', { bubbles: true })); root.render(null) })
  await render('read.ts', 500)
  expect(container.querySelector('pre')?.textContent).toContain('row 660')
  expect(container.querySelector('[aria-label="文件文本"]')?.scrollTop).toBe(75)
  expect(fetchSessionFilePreview).toHaveBeenCalledTimes(2)
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SessionFilePreview key="read.ts" sessionId="one" path="read.ts" line={900} navigation={1} onClose={() => undefined} /></QueryClientProvider>))
  expect(container.querySelector('.bg-accent')?.textContent).toContain('row 900')
  expect(fetchSessionFilePreview).toHaveBeenCalledTimes(2)
})

it('keeps empty-file previews free of the removed toolbar and jump controls', async () => {
  vi.mocked(fetchSessionFilePreview).mockResolvedValue({ path: 'empty', content: '' })
  await render('empty')
  expect(container.textContent).toContain('此文件为空')
  expect(container.querySelector('form')).toBeNull()
  expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['收起预览'])
})

it.each(['docs/readme.md', '/other-project/docs/readme.md'])('renders Markdown at %s with document-relative navigation and safe content', async (path) => {
  const openFile = vi.fn()
  vi.mocked(fetchSessionFilePreview).mockResolvedValue({ path, content: '# Guide\n\n[Code](../src/a.ts#L8)\n\n![remote](https://example.com/track.png)\n\n<script>alert(1)</script>\n' })
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SessionFilePreview key="md" sessionId="one" path={path} onOpenFile={openFile} onClose={() => undefined} /></QueryClientProvider>))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(container.querySelector('h1')?.textContent).toBe('Guide')
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('script')).toBeNull()
  await click('Code')
  expect(openFile).toHaveBeenCalledWith(`${path.slice(0, path.lastIndexOf('/') + 1)}../src/a.ts`, 8)
  expect(container.querySelector('header')?.textContent).toContain(path)
  expect(container.querySelector('[aria-label="Markdown 显示模式"]')).toBeNull()
  expect([...container.querySelectorAll('button')].some((button) => /^(刷新文件|复制路径|源码|阅读|跳转)$/.test(button.textContent ?? ''))).toBe(false)
  await act(async () => root.render(<QueryClientProvider client={queryClient}><SessionFilePreview key="md" sessionId="one" path={path} line={2} navigation={1} onOpenFile={openFile} onClose={() => undefined} /></QueryClientProvider>))
  expect(container.querySelector('[aria-label="文件文本"]')).not.toBeNull()
  expect(container.querySelector('.bg-accent')?.textContent).toContain('2')
})

it('loads image bytes through the authorized API and releases object URLs on refresh and close', async () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.mocked(fetchSessionImagePreview).mockResolvedValue({ path: 'image.png', blob: new Blob(['first'], { type: 'image/png' }) })
  await render('image.png')
  expect(fetchSessionFilePreview).not.toHaveBeenCalled()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:first')
  const image = container.querySelector('img')!
  Object.defineProperties(image, { naturalWidth: { value: 640, configurable: true }, naturalHeight: { value: 480, configurable: true } })
  await act(async () => image.dispatchEvent(new Event('load')))
  await click('原始尺寸')
  expect(image.style.width).toBe('640px')
  const zoomIn = container.querySelector<HTMLButtonElement>('[aria-label="放大图片"]')!
  await act(async () => zoomIn.click())
  expect(container.textContent).toContain('125%')
  vi.mocked(fetchSessionImagePreview).mockResolvedValue({ path: 'image.png', blob: new Blob(['second'], { type: 'image/png' }) })
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ['session-file-preview'] }) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(revoke).toHaveBeenCalledWith('blob:first')
  await act(async () => image.dispatchEvent(new Event('error')))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('解码失败')
  await act(async () => root.render(null))
  expect(revoke).toHaveBeenCalledWith('blob:second')
  create.mockRestore(); revoke.mockRestore()
})
