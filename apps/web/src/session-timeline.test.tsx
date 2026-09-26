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
  it('keeps raw Pi records out of the reading flow while rendering a collapsed execution summary', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} />)

    expect(markup).toContain('用时 3秒')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('answer')
    expect(markup).not.toContain('技术详情')
    expect(markup).not.toContain('本轮原始事件')
    expect(markup).not.toContain('原始 JSON')
  })

  it('expands only the latest running Turn execution', () => {
    const running = render(<SessionTimeline error={false} history={history} isLoading={false} isRunning onRetry={() => undefined} />)

    expect(running).toContain('思考中 ·')
    expect(running).toContain('reasoning')
    expect(running).toContain('aria-expanded="true"')
    expect(running).toContain('aria-label="执行过程"')
    expect(running).toContain('data-final-answer-turn-id="user-1"')
    expect(running).not.toContain('思考过程')
  })

  it('does not mark historical Turns as running when the session is active', () => {
    const twoTurns = {
      ...history,
      entries: [...history.entries,
        { id: 'user-2', parentId: 'user-1', raw: { message: { content: 'second question', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:04.000Z', type: 'message' },
        { id: 'thinking-2', parentId: 'user-2', raw: { assistantMessageEvent: { delta: 'latest reasoning', type: 'thinking_delta' }, type: 'message_update' }, timestamp: '2026-09-22T00:00:05.000Z', type: 'message_update' },
      ],
    }
    const markup = render(<SessionTimeline error={false} history={twoTurns} isLoading={false} isRunning onRetry={() => undefined} />)

    expect((markup.match(/aria-expanded="true"/g) ?? [])).toHaveLength(1)
    expect((markup.match(/aria-expanded="false"/g) ?? [])).toHaveLength(2)
    expect((markup.match(/思考中 ·/g) ?? [])).toHaveLength(1)
  })

  it('keeps timeline content centered while allowing the Rail to move to the message viewport overlay', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} />)

    expect(markup).toContain('aria-label="对话轮次导航"')
    expect(markup).toContain('aria-label="第 1 轮：question"')
    expect(markup).toContain('class="conversation-stage pb-6"')
    expect(markup).toContain('conversation-stage-content space-y-5')
    expect(markup).toContain('md:absolute md:left-0 md:top-1/2')
    expect(markup).not.toContain('md:sticky')
    expect(markup).not.toContain('选择一轮并定位到对应的用户请求。')
  })

  it('keeps every message in the shared content column while bounding user bubbles inside it', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} />)

    expect(markup).toContain('conversation-stage-content space-y-5')
    expect(markup).not.toContain('max-w-3xl')
    expect(markup).toContain('ml-auto w-fit max-w-[min(72%,42rem)]')
    expect(markup).toContain('mb-1 truncate text-right')
    expect(markup).toContain('ml-auto w-fit max-w-full rounded-[10px]')
    expect(markup).toContain('max-h-56 overflow-hidden')
  })

  it('only shows the long-prompt affordance when the collapsed prompt exceeds its height', () => {
    expect(promptOverflows(224, 224)).toBe(false)
    expect(promptOverflows(226, 224)).toBe(true)
  })
})

function render(node: React.ReactNode) { return renderToStaticMarkup(node) }
