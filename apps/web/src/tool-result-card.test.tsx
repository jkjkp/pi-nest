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
