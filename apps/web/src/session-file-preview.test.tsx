// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionFilePreview } from './session-file-preview.js'
import { fetchSessionFilePreview } from './workspace-api.js'

vi.mock('./workspace-api.js', () => ({ fetchSessionFilePreview: vi.fn() }))
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div')
document.body.append(container)
const root = createRoot(container)
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
afterEach(async () => { await act(async () => root.render(null)); queryClient.clear(); vi.mocked(fetchSessionFilePreview).mockReset() })

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
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('文件已删除或不存在。')
  vi.mocked(fetchSessionFilePreview).mockResolvedValue({ path: 'short.ts', content: 'one\ntwo' })
  await render('short.ts', 800)
  expect(container.textContent).toContain('原行号已超出当前文件')
  expect(container.querySelector('.bg-accent')?.textContent).toContain('two')
})
