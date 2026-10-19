// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenToolFile } from './tool-file-context.js'
import { ToolResultCard } from './tool-result-card.js'
import type { ToolResult } from './tool-result-model.js'
import { TurnExecution } from './turn-execution.js'
import type { TimelineItem } from './timeline-model.js'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div')
document.body.append(container)
let root = createRoot(container)
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(container); vi.unstubAllGlobals() })

const result: ToolResult = { name: 'edit', view: 'edit', status: '完成', args: { path: 'a.ts' }, path: 'a.ts', output: 'edited', details: {}, notices: [], patch: '@@ -1 +1 @@\n-old\n+new', changes: { added: 1, removed: 1 } }
async function expand() {
  const details = container.querySelector<HTMLDetailsElement>('[data-tool-result]')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
}

it('lazily renders real patch text without copy controls and opens the current file', async () => {
  const openFile = vi.fn()
  await act(async () => root.render(<OpenToolFile value={openFile}><ToolResultCard result={result} label="编辑 a.ts" /></OpenToolFile>))
  expect(container.textContent).not.toContain('-old')
  await expand()
  expect(container.textContent).toContain('-old')
  expect([...container.querySelectorAll('button')].some((node) => node.textContent?.includes('复制'))).toBe(false)
  await act(async () => container.querySelector<HTMLButtonElement>('button[title]')!.click())
  expect(openFile).toHaveBeenCalledWith('a.ts', undefined, undefined)
})

it('shows only a lightweight file count during execution, without the old result jump', async () => {
  const item: TimelineItem = { id: 't', kind: 'turn', prompt: 'go', parts: [], events: [], diagnostics: [], startedAt: '2026-10-18T00:00:00Z' }
  const activities = ['one', 'two'].map((id) => ({ id, kind: 'tool' as const, result, label: '编辑 a.ts', status: '完成', events: [], duration: undefined }))
  await act(async () => root.render(<TurnExecution item={item} isRunning presentation={{ activities, finalAnswer: [], hasExecution: true }} />))
  expect(container.textContent).toContain('已修改 1 个文件')
  expect(container.textContent).not.toContain('查看结果')
  await act(async () => root.render(<TurnExecution item={item} isRunning={false} runStatus="complete" presentation={{ activities, finalAnswer: [], hasExecution: true }} />))
  expect(container.textContent).not.toContain('已修改 1 个文件')
})

it.each<ToolResult['view']>(['read', 'edit', 'write', 'grep', 'bash', 'generic'])('keeps %s results readable without copy buttons', async (view) => {
  const tool = { ...result, name: view, view, args: { path: 'a.ts', content: 'written text', command: 'echo test', pattern: 'test' }, output: view === 'grep' ? 'a.ts:1: test' : 'tool output' }
  await act(async () => root.render(<ToolResultCard result={tool} label="工具结果" />))
  await expand()
  expect(container.textContent).toContain(view === 'grep' ? 'test' : 'tool output')
  expect([...container.querySelectorAll('button')].some((node) => node.textContent?.includes('复制'))).toBe(false)
})

it.each([['正在执行', '正在运行'], ['完成', '已运行'], ['失败', '运行失败'], ['结果未记录', '结果未记录']])('renders %s commands as compact summaries and preserves full details across updates', async (status, prefix) => {
  const command = "python3 - <<'PY'\n" + 'print("hello")\n'.repeat(40) + 'PY'
  const tool: ToolResult = { name: 'bash', view: 'bash', status, args: { command, cwd: '/workspace' }, output: 'hello', details: { exitCode: 1 }, notices: [] }
  await act(async () => root.render(<ToolResultCard result={tool} label={`运行 ${command}`} duration="2秒" />))
  const details = container.querySelector<HTMLDetailsElement>('[data-tool-result]')!
  const summary = details.querySelector('summary')!
  expect(details.className).not.toMatch(/border|bg-card|rounded/)
  expect(summary.className).toContain('text-xs')
  expect(summary.className).toContain(status === '失败' ? 'text-destructive' : 'text-muted-foreground')
  expect(summary.querySelector('.truncate')?.textContent).toBe(`${prefix} ${command.replace(/\s*\r?\n\s*/g, ' ')}`)
  expect(summary.textContent).not.toMatch(/\n|展开查看|收起|exit/)
  expect(container.querySelector('pre')).toBeNull()
  await expand()
  expect(container.querySelector('section[aria-label="命令"] pre')?.textContent).toContain("python3 - <<'PY'")
  expect(container.querySelectorAll('section[aria-label="命令"] pre > span')).toHaveLength(42)
  expect(container.textContent).toContain('工作目录：/workspace')
  expect(container.textContent).toContain('exit 1 · 2秒')
  await act(async () => root.render(<ToolResultCard result={{ ...tool, output: 'updated output' }} label={`运行 ${command}`} duration="3秒" />))
  expect(details.open).toBe(true)
  expect(container.textContent).toContain('updated output')
  await act(async () => { details.open = false; details.dispatchEvent(new Event('toggle')) })
  expect(container.querySelector('pre')).toBeNull()
})

it('removes the latest hint while preserving pause and resume of execution scrolling', async () => {
  const item: TimelineItem = { id: 'scroll', kind: 'turn', prompt: 'go', parts: [], events: [], diagnostics: [], startedAt: new Date().toISOString() }
  const render = (text: string) => act(async () => root.render(<TurnExecution item={item} isRunning presentation={{ activities: [{ id: 'thinking', kind: 'thinking', text }], finalAnswer: [], hasExecution: true }} />))
  await render('first')
  const viewport = container.querySelector<HTMLDivElement>('[aria-label="执行过程"]')!
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } })
  await act(async () => { viewport.scrollTop = 200; viewport.dispatchEvent(new Event('scroll')) })
  expect(container.textContent).not.toContain('查看最新')
  await render('second')
  expect(viewport.scrollTop).toBe(200)
  await act(async () => { viewport.scrollTop = 900; viewport.dispatchEvent(new Event('scroll')) })
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1200 })
  await render('third')
  expect(viewport.scrollTop).toBe(1200)
})
