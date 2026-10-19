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

it.each<ToolResult['view']>(['read', 'edit', 'write', 'grep', 'bash', 'generic'])('animates only running %s summary text and stops when the tool settles', async (view) => {
  const tool: ToolResult = { name: view, view, status: '正在执行', args: { command: 'echo hello' }, output: '', details: {}, notices: [] }
  await act(async () => root.render(<ToolResultCard result={tool} label={view === 'bash' ? '运行 echo hello' : '工具调用'} />))
  const summary = container.querySelector('summary')!
  expect(summary.querySelector('.command-running')?.textContent).toContain('正在')
  expect(summary.querySelector('svg')?.classList.contains('command-running')).toBe(false)
  await expand()
  expect(container.querySelectorAll('.command-running')).toHaveLength(1)
  for (const status of ['完成', '失败', '结果未记录']) {
    await act(async () => root.render(<ToolResultCard result={{ ...tool, status }} label="运行 echo hello" />))
    expect(container.querySelector('.command-running')).toBeNull()
    expect(container.querySelector<HTMLDetailsElement>('[data-tool-result]')?.open).toBe(true)
  }
})

const toolSummaries: [ToolResult['view'], string, string, string, string][] = [
  ['read', '读取 /workspace/a.ts', '正在读取 /workspace/a.ts', '已读取 /workspace/a.ts', '读取失败 /workspace/a.ts'],
  ['grep', '搜索 test', '正在搜索 test', '已搜索 test', '搜索失败 test'],
  ['edit', '编辑 /workspace/a.ts', '正在编辑 /workspace/a.ts', '已编辑 /workspace/a.ts', '编辑失败 /workspace/a.ts'],
  ['write', '编辑 /workspace/a.ts', '正在写入 /workspace/a.ts', '已写入 /workspace/a.ts', '写入失败 /workspace/a.ts'],
  ['generic', '搜索内容', '正在搜索 内容', '已搜索 内容', '搜索失败 内容'],
  ['generic', 'Custom Tool', '正在调用 Custom Tool', '已调用 Custom Tool', '调用失败 Custom Tool'],
]

it.each(toolSummaries)('renders %s %s as a compact summary through every status', async (view, label, running, complete, failed) => {
  const tool: ToolResult = { name: view === 'generic' ? 'custom_tool' : view, view, status: '正在执行', args: { path: '/workspace/a.ts' }, path: '/workspace/a.ts', output: 'original output', details: {}, notices: ['工具返回的内容已截断'] }
  for (const [status, title] of [['正在执行', running], ['完成', complete], ['失败', failed], ['结果未记录', '结果未记录 ' + (view === 'write' ? tool.path : label.replace(/^(读取|搜索|编辑)\s*/, ''))]]) {
    await act(async () => root.render(<ToolResultCard result={{ ...tool, status }} label={label} duration="11秒" />))
    const details = container.querySelector<HTMLDetailsElement>('[data-tool-result]')!
    const summary = details.querySelector('summary')!
    expect(details.className).not.toMatch(/border|bg-card|rounded/)
    expect(summary.className).toContain(status === '失败' ? 'text-destructive' : 'text-muted-foreground')
    expect(summary.textContent).toBe(title)
    expect(summary.querySelector('[title]')?.getAttribute('title')).toBe(title)
    expect(summary.querySelector('.truncate')).not.toBeNull()
    expect(summary.textContent).not.toMatch(/展开查看|收起|11秒/)
    expect(container.querySelector('pre')).toBeNull()
    await expand()
    expect(container.textContent).toContain('original output')
    expect(container.textContent).toContain(`${status} · 11秒`)
    expect(container.textContent).toContain('工具返回的内容已截断')
    await act(async () => root.render(<ToolResultCard result={{ ...tool, status, output: 'updated output' }} label={label} duration="12秒" />))
    expect(details.open).toBe(true)
    expect(container.textContent).toContain('updated output')
    expect(details.querySelector('div')?.className).not.toContain('border-t')
    await act(async () => { details.open = false; details.dispatchEvent(new Event('toggle')) })
  }
})

it.each(['running', 'complete', 'aborted', 'error', undefined] as const)('keeps tool failures inside execution for %s turns', async (runStatus) => {
  const item: TimelineItem = { id: 'failed', kind: 'turn', prompt: 'go', parts: [], events: [], diagnostics: [], startedAt: new Date().toISOString() }
  const failed = { ...result, name: 'read', view: 'read' as const, status: '失败', output: 'permission denied' }
  const activities = [
    { id: 'failed-read', kind: 'tool' as const, result: failed, label: '读取 a.ts', status: '失败', duration: 1000, events: [] },
    { id: 'failed-bash', kind: 'bash' as const, command: 'exit 1', cwd: undefined, status: '失败', duration: 1000, events: [], exitCode: 1, stdout: undefined, stderr: 'command failed' },
  ]
  await act(async () => root.render(<TurnExecution item={item} isRunning={runStatus === 'running'} runStatus={runStatus} presentation={{ activities, finalAnswer: [], hasExecution: true }} />))
  expect(container.textContent).not.toMatch(/项执行失败|查看失败/)
  if (runStatus !== 'running') await act(async () => container.querySelector<HTMLButtonElement>('[data-execution-toggle]')!.click())
  const viewport = container.querySelector('[aria-label="执行过程"]')!
  expect(viewport.textContent).toContain('读取失败 a.ts')
  expect(viewport.textContent).toContain('运行失败 exit 1')
  await expand()
  expect(viewport.textContent).toContain('permission denied')
  if (runStatus === 'error') expect(container.querySelector('[data-execution-toggle]')?.textContent).toContain('执行失败')
})
