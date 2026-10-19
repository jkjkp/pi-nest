import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { TurnExecution } from './turn-execution.js'
import { shouldExecutionFollowLatest } from './turn-execution-scroll.js'
import type { TimelineItem } from './timeline-model.js'

const item: TimelineItem = { diagnostics: [], events: [], id: 'turn-1', kind: 'turn', parts: [], prompt: 'go', startedAt: '2026-09-22T00:00:00.000Z' }

describe('TurnExecution scrolling', () => {
  it('bounds an expanded execution viewport instead of growing the conversation indefinitely', () => {
    const markup = renderToStaticMarkup(<TurnExecution isRunning item={item} presentation={{ activities: [{ id: 'thinking', kind: 'thinking', text: 'working' }], finalAnswer: [], hasExecution: true }} />)

    expect(markup).toContain('aria-label="执行过程"')
    expect(markup).toContain('max-h-[min(38vh,22.5rem)]')
    expect(markup).toContain('overflow-y-auto overscroll-contain')
  })

  it('uses acknowledgement phases before Pi starts execution and never renders an unknown duration', () => {
    const submitted = renderToStaticMarkup(<TurnExecution isRunning item={item} presentation={{ activities: [], finalAnswer: [], hasExecution: false }} runStatus="submitted" />)
    const acknowledged = renderToStaticMarkup(<TurnExecution isRunning item={item} presentation={{ activities: [], finalAnswer: [], hasExecution: false }} runStatus="awaiting_agent" />)
    const awaitingInput = renderToStaticMarkup(<TurnExecution isRunning={false} item={item} presentation={{ activities: [], finalAnswer: [], hasExecution: false }} runStatus="awaiting_input" />)
    const completed = renderToStaticMarkup(<TurnExecution isRunning={false} item={item} presentation={{ activities: [], finalAnswer: [], hasExecution: false }} />)

    expect(submitted).toContain('已提交，正在连接 Pi…')
    expect(acknowledged).toContain('Pi 已接收，正在准备执行…')
    expect(awaitingInput).toContain('等待你的回答…')
    expect(completed).toContain('正在同步执行状态…')
    expect(`${submitted}${acknowledged}${completed}`).not.toContain('用时 —')
  })

  it('stops internal follow after the reader leaves the bottom threshold', () => {
    expect(shouldExecutionFollowLatest(1_000, 860, 100)).toBe(true)
    expect(shouldExecutionFollowLatest(1_000, 800, 100)).toBe(false)
  })

  it('keeps a collapsed animation shell while excluding hidden execution from focus and reading', () => {
    const presentation = { activities: [{ id: 'thinking', kind: 'thinking' as const, text: 'working' }], finalAnswer: [], hasExecution: true }
    const collapsed = renderToStaticMarkup(<TurnExecution isRunning={false} item={item} presentation={presentation} />)
    expect(collapsed).toContain('class="execution-collapse" data-expanded="false" aria-hidden="true" inert=""')
    expect(collapsed).toContain('id="turn-execution-turn-1"')
    expect(collapsed).not.toContain('working')
    const expanded = renderToStaticMarkup(<TurnExecution isRunning item={item} presentation={presentation} />)
    expect(expanded).toContain('data-expanded="true" aria-hidden="false"')
    expect(expanded).not.toContain('inert=""')
  })
})


it('keeps command details out of the timer title and retains the final duration', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(item.startedAt) + 30_000)
  const command = '运行 cd /workspace && ' + 'pnpm test '.repeat(40)
  const presentation = { activities: [{ id: 'tool', kind: 'tool' as const, label: command, status: '正在执行', duration: undefined, events: [] }], finalAnswer: [], hasExecution: true }
  try {
    const markup = renderToStaticMarkup(<TurnExecution isRunning item={item} presentation={presentation} runStatus="running" />)
    const title = markup.match(/<button data-execution-toggle=""[\s\S]*?<\/button>/)?.[0]
    expect(title).toContain('用时 30秒')
    expect(title).not.toContain('运行')
    expect(title).toContain('aria-live="off"')
    expect(markup).toContain('pnpm test')
    const completed = renderToStaticMarkup(<TurnExecution isRunning={false} item={{ ...item, runtimeTiming: { startedAt: item.startedAt, completedAt: new Date(Date.parse(item.startedAt) + 30_000).toISOString() } }} presentation={presentation} />)
    expect(completed).toContain('用时 30秒')
  } finally { clock.mockRestore() }
})

it.each([['aborting', '正在停止…'], ['aborted', '已停止'], ['error', '执行失败']] as const)('preserves the %s status', (runStatus, label) => {
  const markup = renderToStaticMarkup(<TurnExecution isRunning={runStatus === 'aborting'} item={item} presentation={{ activities: [], finalAnswer: [], hasExecution: false }} runStatus={runStatus} />)
  expect(markup).toContain(label)
})
