import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

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
})
