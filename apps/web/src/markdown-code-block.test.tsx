// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantMarkdown } from './assistant-markdown.js'
import { MarkdownCodeBlock, maxHighlightLength } from './markdown-code-block.js'

const { highlightCode } = vi.hoisted(() => ({ highlightCode: vi.fn() }))
vi.mock('./code-highlight.js', () => ({ highlightCode }))
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  highlightCode.mockReset().mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const codeText = () => container.querySelector('pre code')?.textContent
const copyButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="复制代码"]')!

it('copies the latest raw code, preserves whitespace and keeps toolbar state through streaming updates', async () => {
  vi.useFakeTimers()
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const render = (code: string, streaming: boolean) => act(() => root.render(<AssistantMarkdown isStreaming={streaming} source={`\`\`\`js\n${code}\n\`\`\``} />))
  await render('  first\n', true)
  await act(() => copyButton().click())
  expect(writeText).toHaveBeenLastCalledWith('  first\n')
  expect(copyButton().getAttribute('title')).toBe('已复制')
  await render('  first\n\n  second', true)
  expect(copyButton().getAttribute('title')).toBe('已复制')
  await act(() => vi.advanceTimersByTime(1500))
  expect(copyButton().getAttribute('title')).toBe('复制代码')
  await act(() => copyButton().click())
  expect(writeText).toHaveBeenLastCalledWith('  first\n\n  second')
  expect(highlightCode).not.toHaveBeenCalled()
  await render('  first\n\n  second', false)
  await vi.waitFor(() => expect(highlightCode).toHaveBeenCalled())
  expect(copyButton().getAttribute('title')).toBe('已复制')
})

it('reports unavailable or denied clipboard access and lets the reader retry', async () => {
  vi.stubGlobal('navigator', {})
  await act(() => root.render(<MarkdownCodeBlock code="raw" isStreaming />))
  await act(() => copyButton().click())
  expect(container.textContent).toContain('复制失败')
  const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  await act(() => copyButton().click())
  expect(container.textContent).toContain('复制失败')
  await act(() => copyButton().click())
  expect(copyButton().getAttribute('title')).toBe('已复制')
  expect(container.textContent).not.toContain('复制失败')
})

it('ignores stale async highlighting and retains plain text on failure', async () => {
  let resolveOld!: (value: { content: string }[][]) => void
  highlightCode.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
  await act(() => root.render(<MarkdownCodeBlock code="old" language="js" isStreaming={false} />))
  await vi.waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(1))
  highlightCode.mockResolvedValueOnce([[{ content: 'new', color: '#123456' }]])
  await act(() => root.render(<MarkdownCodeBlock code="new" language="js" isStreaming={false} />))
  await vi.waitFor(() => expect(container.querySelector('pre span')).not.toBeNull())
  await act(() => resolveOld([[{ content: 'old' }]]))
  expect(codeText()).toBe('new')
  highlightCode.mockRejectedValueOnce(new Error('load failure'))
  await act(() => root.render(<MarkdownCodeBlock code="fallback" language="js" isStreaming={false} />))
  await vi.waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(3))
  expect(codeText()).toBe('fallback')
  expect(container.querySelector('pre span')).toBeNull()
})

it('skips streaming, unlabelled and oversized code and escapes unknown code', async () => {
  for (const props of [{ code: 'stream', language: 'js', isStreaming: true }, { code: 'plain', isStreaming: false }, { code: 'x'.repeat(maxHighlightLength + 1), language: 'js', isStreaming: false }]) {
    await act(() => root.render(<MarkdownCodeBlock {...props} />))
    expect(codeText()).toBe(props.code)
  }
  expect(highlightCode).not.toHaveBeenCalled()
  await act(() => root.render(<MarkdownCodeBlock code="<img src=x onerror=alert(1)>" language="unknown" isStreaming={false} />))
  expect(container.querySelector('img')).toBeNull()
  expect(codeText()).toBe('<img src=x onerror=alert(1)>')
})

it('toggles wrapping per block, retains it during streaming and copies unchanged source', async () => {
  const code = '  ' + 'long'.repeat(80) + '\n\n  next'
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const render = (value: string) => act(() => root.render(<><MarkdownCodeBlock code={value} isStreaming /><MarkdownCodeBlock code="other" isStreaming /></>))
  await render(code)
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!
  const pre = container.querySelector('pre')!
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  expect(toggle.getAttribute('aria-label')).toBe('自动换行')
  expect(toggle.getAttribute('title')).toBe('开启自动换行')
  expect(toggle.textContent).toBe('')
  expect(copyButton().textContent).toBe('')
  expect(pre.classList.contains('whitespace-pre')).toBe(true)
  await act(() => toggle.click())
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  expect(toggle.getAttribute('title')).toBe('关闭自动换行')
  expect(pre.classList.contains('whitespace-pre-wrap')).toBe(true)
  expect(container.querySelectorAll('button[aria-pressed]')[1]?.getAttribute('aria-pressed')).toBe('false')
  await render(code + ' updated')
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  await act(() => copyButton().click())
  expect(writeText).toHaveBeenCalledWith(code + ' updated')
  await act(() => toggle.click())
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  expect(pre.classList.contains('whitespace-pre')).toBe(true)
})
