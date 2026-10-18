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

it('lazily renders real patch text, copies the recorded patch, and opens the current file', async () => {
  const openFile = vi.fn()
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  await act(async () => root.render(<OpenToolFile value={openFile}><ToolResultCard result={result} label="编辑 a.ts" /></OpenToolFile>))
  expect(container.textContent).not.toContain('-old')
  await expand()
  expect(container.textContent).toContain('-old')
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === '复制补丁')!
  await act(async () => button.click())
  expect(writeText).toHaveBeenCalledWith(result.patch)
  expect(container.textContent).toContain('已复制')
  await act(async () => container.querySelector<HTMLButtonElement>('button[title]')!.click())
  expect(openFile).toHaveBeenCalledWith('a.ts', undefined, undefined)
})

it('retains a visible result entry after execution has collapsed and deduplicates files', async () => {
  const item: TimelineItem = { id: 't', kind: 'turn', prompt: 'go', parts: [], events: [], diagnostics: [], startedAt: '2026-10-18T00:00:00Z' }
  const activities = ['one', 'two'].map((id) => ({ id, kind: 'tool' as const, result, label: '编辑 a.ts', status: '完成', events: [], duration: undefined }))
  await act(async () => root.render(<TurnExecution item={item} isRunning={false} presentation={{ activities, finalAnswer: [], hasExecution: true }} />))
  expect(container.textContent).toContain('修改 1 个文件 · 查看结果')
  expect(container.querySelector('[data-expanded]')?.getAttribute('data-expanded')).toBe('false')
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return 1 })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  await act(async () => { frames.forEach((callback) => callback(0)) })
  expect(container.querySelector('[data-expanded]')?.getAttribute('data-expanded')).toBe('true')
  expect(container.querySelector<HTMLDetailsElement>('[data-tool-result]')?.open).toBe(true)
})
