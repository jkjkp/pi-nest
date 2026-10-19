import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SessionTimeline } from './session-timeline.js'
import { promptOverflows } from './user-prompt-state.js'

const history = {
  entries: [
    { id: 'user-1', parentId: null, raw: { message: { content: 'question', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'message' },
    { id: 'custom-1', parentId: 'user-1', raw: { type: 'custom' }, timestamp: '2026-09-22T00:00:01.000Z', type: 'custom' },
    { id: 'thinking-1', parentId: 'user-1', raw: { assistantMessageEvent: { delta: 'reasoning', type: 'thinking_delta' }, type: 'message_update' }, timestamp: '2026-09-22T00:00:02.000Z', type: 'message_update' },
    { id: 'assistant-1', parentId: 'user-1', raw: { message: { content: 'answer', role: 'assistant', stopReason: 'stop' }, type: 'message' }, timestamp: '2026-09-22T00:00:03.000Z', type: 'message' },
  ],
  hasEarlier: false,
  revision: 'fixture',
  session: { id: 'session-1' },
}

describe('SessionTimeline', () => {
  it('keeps the answer readable while showing navigation failure and a retry action', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} navigationNotice="完整轮次导航暂不可用" onRetryNavigation={() => undefined} />)
    expect(markup).toContain('完整轮次导航暂不可用')
    expect(markup).toContain('重试')
    expect(markup).toContain('answer')
    expect(markup).not.toContain('无法读取会话历史')
  })
  it('keeps raw Pi records out of the reading flow while rendering a collapsed execution summary', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} />)

    expect(markup).toContain('用时 3秒')
    expect(markup).toContain('data-turn-execution=""')
    expect((markup.match(/aria-expanded="false"/g) ?? [])).toHaveLength(1)
    expect(markup).toContain('answer')
    expect(markup).not.toContain('技术详情')
    expect(markup).not.toContain('本轮原始事件')
    expect(markup).not.toContain('原始 JSON')
    expect(markup).not.toContain('当前仅展示最近 200 条原生条目。')
  })

  it('expands only the latest running Turn execution', () => {
    const running = render(<SessionTimeline error={false} history={history} isLoading={false} isRunning onRetry={() => undefined} />)

    expect(running).toContain('思考中</span> ·')
    expect(running).toContain('reasoning')
    expect(running).toContain('aria-expanded="true"')
    expect(running).toContain('aria-label="执行过程"')
    expect(running).toContain('data-final-answer-turn-id="user-1"')
    expect(running).not.toContain('思考过程')
  })

  it('keeps queued inputs out of the transcript until Pi executes them', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} isRunning onRetry={() => undefined} pendingInputs={[{ id: 'pending-1', message: '查找关于 ai 的最新的信息', mode: 'follow_up', submittedAt: '2026-09-27T11:15:55.000Z' }]} />)

    expect(markup).not.toContain('查找关于 ai 的最新的信息')
    expect(markup).not.toContain('已发送 · Follow-up')
    expect(markup).not.toContain('data-pending-input="pending-1"')
  })

  it('shows a steering bubble immediately without pretending execution has started', () => {
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} isRunning onRetry={() => undefined} turns={[{ id: 'steering', prompt: '现在改查落库', events: [], startedAt: '2026-10-14T00:00:00Z', steering: { status: 'accepted' } }]} />)
    expect(markup).toContain('现在改查落库')
    expect(markup).toContain('引导已发送')
    expect(markup).not.toContain('turn-execution-steering')
  })

  it('shows a failed steering message with retry and does not offer retries for uncertain delivery', () => {
    const turn = { id: 'steering', prompt: '补充要求', events: [], startedAt: '2026-10-14T00:00:00Z', steering: { status: 'failed' as const, error: 'Rejected' } }
    const failed = render(<SessionTimeline error={false} history={undefined} isLoading={false} isRunning onRetry={() => undefined} onRetrySteering={() => undefined} turns={[turn]} />)
    expect(failed).toContain('发送失败：Rejected')
    expect(failed).toContain('>重试</button>')
    const unknown = render(<SessionTimeline error={false} history={undefined} isLoading={false} isRunning onRetry={() => undefined} onRetrySteering={() => undefined} turns={[{ ...turn, steering: { status: 'unknown' } }]} />)
    expect(unknown).toContain('正在确认发送状态，请勿重复发送')
    expect(unknown).not.toContain('>重试</button>')
  })

  it('keeps a persisted execution expandable after refresh', () => {
    const refreshed = {
      ...history,
      entries: [
        { id: 'user-1', parentId: null, raw: { message: { content: 'question', role: 'user' }, type: 'message' }, timestamp: '2026-09-22T00:00:00.000Z', type: 'message' },
        { id: 'assistant-1', parentId: 'user-1', raw: { message: { content: [{ thinking: 'historical reasoning', type: 'thinking' }, { id: 'call-1', name: 'read', type: 'toolCall' }], role: 'assistant' }, type: 'message' }, timestamp: '2026-09-22T00:00:01.000Z', type: 'message' },
        { id: 'tool-1', parentId: 'assistant-1', raw: { message: { content: [], isError: false, role: 'toolResult', toolCallId: 'call-1', toolName: 'read' }, type: 'message' }, timestamp: '2026-09-22T00:00:02.000Z', type: 'message' },
        { id: 'assistant-2', parentId: 'tool-1', raw: { message: { content: [{ text: 'answer', type: 'text' }], role: 'assistant', stopReason: 'stop' }, type: 'message' }, timestamp: '2026-09-22T00:00:03.000Z', type: 'message' },
      ],
    }
    const markup = render(<SessionTimeline error={false} history={refreshed} isLoading={false} onRetry={() => undefined} />)

    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('用时 3秒')
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
    expect((markup.match(/思考中<\/span> ·/g) ?? [])).toHaveLength(1)
  })

  it('keeps timeline content centered while allowing the Rail to move to the message viewport overlay', () => {
    const markup = render(<SessionTimeline error={false} history={{ ...history, entries: [...history.entries, { ...history.entries[0]!, id: 'user-2', timestamp: '2026-09-22T00:01:00.000Z' }] }} isLoading={false} onRetry={() => undefined} />)

    expect(markup).toContain('aria-label="对话轮次导航"')
    expect(markup).toContain('第 1 轮：question')
    expect(markup).toContain('class="conversation-stage pb-6"')
    expect(markup).toContain('conversation-stage-content space-y-5')
    expect(markup).toContain('absolute right-0')
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

  it('mounts only the virtual window for hundreds of loaded Turns', () => {
    const longHistory = {
      ...history,
      entries: Array.from({ length: 500 }, (_, index) => ({
        id: `user-${index}`,
        parentId: index === 0 ? null : `user-${index - 1}`,
        raw: { message: { content: `question ${index}`, role: 'user' }, type: 'message' },
        timestamp: `2026-09-22T00:${String(index).padStart(2, '0')}:00.000Z`,
        type: 'message',
      })),
    }
    const markup = render(<SessionTimeline error={false} history={longHistory} isLoading={false} onRetry={() => undefined} />)

    expect((markup.match(/data-turn-id=/g) ?? []).length).toBeLessThan(40)
    expect(markup).toContain('data-turn-id="user-0"')
    expect(markup).not.toContain('data-turn-id="user-499"')
  })

  it('uses the complete Turn Index for a density Rail while the body remains virtualized', () => {
    const turnIndex = { entries: Array.from({ length: 3_000 }, (_, index) => ({ id: `user-${index + 1}`, index: index + 1, promptPreview: `prompt ${index + 1}`, startedAt: '2026-09-22T00:00:00.000Z' })), revision: 'fixture' }
    const markup = render(<SessionTimeline error={false} history={history} isLoading={false} onRetry={() => undefined} turnIndex={turnIndex} />)

    expect((markup.match(/data-rail-marker=""/g) ?? [])).toHaveLength(10)
    expect((markup.match(/data-turn-id=/g) ?? []).length).toBeLessThan(40)
  })

  it('only shows the long-prompt affordance when the collapsed prompt exceeds its height', () => {
    expect(promptOverflows(224, 224)).toBe(false)
    expect(promptOverflows(226, 224)).toBe(true)
  })

})

function render(node: React.ReactNode) { return renderToStaticMarkup(node) }

function fileHistory(finalAnswer = true) {
  return { ...history, session: { id: 'session-1', cwd: '/project' }, entries: [
    { id: 'file-user', parentId: null, timestamp: '2026-10-18T00:00:00Z', type: 'message', raw: { type: 'message', message: { role: 'user', content: 'write a file' } } },
    { id: 'file-call', parentId: 'file-user', timestamp: '2026-10-18T00:00:01Z', type: 'message', raw: { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'write', id: 'write-one', arguments: { path: 'result.md', content: 'recorded content' } }], stopReason: 'toolUse' } } },
    { id: 'file-result', parentId: 'file-call', timestamp: '2026-10-18T00:00:02Z', type: 'message', raw: { type: 'message', message: { role: 'toolResult', toolCallId: 'write-one', toolName: 'write', isError: false, content: [{ type: 'text', text: 'Successfully wrote result.md' }] } } },
    ...(finalAnswer ? [{ id: 'file-answer', parentId: 'file-result', timestamp: '2026-10-18T00:00:03Z', type: 'message', raw: { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '正文已经输出完毕。' }] } } }] : []),
  ] }
}

it('renders a restored file summary after the final answer instead of inside the execution region', () => {
  const markup = render(<SessionTimeline error={false} history={fileHistory()} isLoading={false} onRetry={() => undefined} />)
  const answer = markup.indexOf('正文已经输出完毕。')
  const summary = markup.indexOf('data-turn-file-summary=""')
  expect(answer).toBeGreaterThan(0)
  expect(summary).toBeGreaterThan(answer)
  expect(markup).toContain('文件变更 · 1 个文件')
  expect(markup).toContain('result.md')
  expect(markup).not.toContain('查看结果')
  expect(markup).not.toContain('recorded content')
})

it('does not show a final summary during tool execution, final text streaming or input waits', () => {
  for (const props of [{ isRunning: true }, { runStatus: 'awaiting_input' as const }, { runStatus: 'awaiting_agent' as const }]) {
    const markup = render(<SessionTimeline error={false} history={fileHistory()} isLoading={false} onRetry={() => undefined} {...props} />)
    expect(markup).not.toContain('data-turn-file-summary')
    expect(markup).toContain('已修改 1 个文件')
  }
  expect(render(<SessionTimeline error={false} history={fileHistory(false)} isLoading={false} onRetry={() => undefined} />)).not.toContain('data-turn-file-summary')
})

it('keeps successful modifications visible after an interruption even without a final answer', () => {
  const markup = render(<SessionTimeline error={false} history={fileHistory(false)} isLoading={false} onRetry={() => undefined} runStatus="aborted" />)
  expect(markup).toContain('data-turn-file-summary')
  expect(markup).toContain('任务已中断')
  expect(markup).toContain('已写入')
})

it('keeps each summary scoped to its own turn when a later request begins', () => {
  const next = { ...fileHistory(), entries: [...fileHistory().entries, { id: 'next-user', parentId: 'file-answer', timestamp: '2026-10-18T00:00:05Z', type: 'message', raw: { type: 'message', message: { role: 'user', content: 'read only now' } } }] }
  const markup = render(<SessionTimeline error={false} history={next} isLoading={false} isRunning onRetry={() => undefined} runStatus="running" />)
  expect(markup.match(/data-turn-file-summary=""/g)).toHaveLength(1)
  expect(markup.indexOf('data-turn-file-summary')).toBeLessThan(markup.indexOf('data-turn-id="next-user"'))
})
