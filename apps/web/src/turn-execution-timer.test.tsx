// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TurnExecution } from './turn-execution.js'
import type { TurnActivity } from './turn-execution-model.js'
import type { TimelineItem } from './timeline-model.js'

it('continues timing across thinking, tools and answer updates without reopening a collapsed process', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T06:00:00Z'))
  const item: TimelineItem = { diagnostics: [], events: [], id: 'timer', kind: 'turn', prompt: 'go', parts: [], startedAt: new Date().toISOString() }
  const element = document.createElement('div')
  const root = createRoot(element)
  const render = (activity: TurnActivity) => act(() => root.render(<TurnExecution item={item} isRunning runStatus="running" presentation={{ activities: [activity], finalAnswer: [], hasExecution: true }} />))
  const title = () => element.querySelector<HTMLButtonElement>('[data-execution-toggle]')!
  try {
    await render({ id: 'thinking', kind: 'thinking', text: '思考内容' })
    await act(() => vi.advanceTimersByTime(2_000))
    expect(title().textContent).toBe('用时 2秒')
    await act(() => title().click())
    await render({ id: 'tool', kind: 'tool', label: '运行 very-long-command', status: '正在执行', duration: undefined, events: [] })
    await act(() => vi.advanceTimersByTime(2_000))
    expect(title().textContent).toBe('用时 4秒')
    expect(title().getAttribute('aria-expanded')).toBe('false')
    await render({ id: 'answer', kind: 'narration', text: '正在回答' })
    await act(() => vi.advanceTimersByTime(2_000))
    expect(title().textContent).toBe('用时 6秒')
  } finally {
    await act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
