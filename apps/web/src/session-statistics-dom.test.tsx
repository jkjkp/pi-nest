// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionStatistics } from './session-statistics.js'
import type { RuntimeStatisticsState } from './workspace-store.js'

let root: Root
let container: HTMLDivElement
const data = { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.01, contextUsage: { tokens: 420, percent: 42, contextWindow: 1000 } }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function render(details?: RuntimeStatisticsState, onRetry = vi.fn()) {
  await act(() => root.render(<SessionStatistics details={details} onRetry={onRetry} open />))
}

it('replaces pre-compaction usage with a pending explanation and restores numeric usage on the next response', async () => {
  await render({ data })
  expect(container.textContent).toBe('42%')
  await render({ data: { ...data, contextUsage: { tokens: null, percent: null, contextWindow: 1000 } } })
  expect(container.textContent).toBe('—')
  expect(document.body.textContent).toContain('上下文用量待更新')
  expect(document.body.textContent).toContain('下一次有效模型回复后更新')
  expect(document.body.textContent).not.toContain('42%')
  await render({ data: { ...data, contextUsage: { tokens: 80, percent: 8, contextWindow: 1000 } } })
  expect(container.textContent).toBe('8%')
  expect(document.body.textContent).not.toContain('下一次有效模型回复后更新')
})

it('distinguishes unavailable context, loading, and a failed refresh with retained data', async () => {
  await render({ data: { ...data, contextUsage: undefined } })
  expect(document.body.textContent).toContain('上下文统计暂不可用')
  await render({ data, loading: true })
  expect(document.body.textContent).toContain('正在读取统计')
  const onRetry = vi.fn()
  await render({ data, error: '统计读取失败，请重试。' }, onRetry)
  expect(document.body.textContent).toContain('当前显示上次读取的数据')
  expect(container.textContent).toBe('42%')
  await act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === '重试')!.click())
  expect(onRetry).toHaveBeenCalledOnce()
})
