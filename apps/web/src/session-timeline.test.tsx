import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SessionTimeline } from './session-timeline.js'

const history = {
  entries: [
    { id: 'user-1', parentId: null, raw: { message: { content: 'question', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'message' },
    { id: 'custom-1', parentId: 'user-1', raw: { type: 'custom' }, timestamp: '2026-09-22T00:00:01.000Z', type: 'custom' },
    { id: 'thinking-1', parentId: 'user-1', raw: { assistantMessageEvent: { delta: 'reasoning', type: 'thinking_delta' }, type: 'message_update' }, timestamp: '2026-09-22T00:00:02.000Z', type: 'message_update' },
    { id: 'assistant-1', parentId: 'user-1', raw: { message: { content: 'answer', role: 'assistant' }, type: 'message' }, timestamp: '2026-09-22T00:00:03.000Z', type: 'message' },
  ],
  hasEarlier: false,
  session: { id: 'session-1' },
}

describe('SessionTimeline', () => {
  it('keeps raw Pi records in one closed technical-details disclosure instead of the reading flow', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} />)

    expect(markup).toContain('技术详情（4 条事件）')
    expect(markup).toContain('本轮原始事件')
    expect(markup).not.toContain('Pi 原生事件')
    expect(markup).not.toContain('原始 JSON')
    expect(markup).not.toMatch(/<details[^>]*open[^>]*>.*技术详情/)
  })

  it('expands thinking only while the turn is running', () => {
    const complete = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} />)
    const running = render(<SessionTimeline error={false} history={history} isLoading={false} isRunning onRetry={() => undefined} />)

    expect(complete).toContain('思考过程')
    expect(complete).not.toMatch(/<details[^>]*open[^>]*><summary[^>]*>思考过程/)
    expect(running).toMatch(/<details[^>]*open[^>]*><summary[^>]*>思考中/)
  })

  it('provides an overlay Turn rail without a narrow-screen Sheet entry', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} />)

    expect(markup).toContain('aria-label="对话轮次导航"')
    expect(markup).toContain('aria-label="第 1 轮：question"')
    expect(markup).toContain('md:sticky')
    expect(markup).not.toContain('选择一轮并定位到对应的用户请求。')
    expect(markup).not.toContain('grid-cols-1')
  })
})

function render(node: React.ReactNode) { return renderToStaticMarkup(node) }
