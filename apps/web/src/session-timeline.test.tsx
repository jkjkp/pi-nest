import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SessionTimeline } from './session-timeline.js'
import { promptOverflows } from './user-prompt-state.js'

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

  it('reserves a desktop gutter for the rail while keeping the outline as an overlay', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} />)

    expect(markup).toContain('aria-label="对话轮次导航"')
    expect(markup).toContain('aria-label="第 1 轮：question"')
    expect(markup).toContain('md:grid-cols-[3rem_minmax(0,1fr)] md:gap-x-4')
    expect(markup).toContain('md:col-start-2')
    expect(markup).toContain('md:sticky')
    expect(markup).not.toContain('选择一轮并定位到对应的用户请求。')
  })

  it('keeps user prompts right-aligned and bounded by their Main content column', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} />)

    expect(markup).toContain('ml-auto w-fit min-w-0 max-w-[min(72%,42rem)]')
    expect(markup).toContain('max-h-56 overflow-hidden')
  })

  it('only shows the long-prompt affordance when the collapsed prompt exceeds its height', () => {
    expect(promptOverflows(224, 224)).toBe(false)
    expect(promptOverflows(226, 224)).toBe(true)
  })
})

function render(node: React.ReactNode) { return renderToStaticMarkup(node) }
