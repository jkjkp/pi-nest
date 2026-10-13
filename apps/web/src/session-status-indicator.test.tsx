import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionStatusIndicator } from './session-status-indicator.js'

describe('sidebar status', () => {
  it('keeps a fixed slot and makes active work take priority over unread replies', () => {
    const idle = renderToStaticMarkup(<SessionStatusIndicator status="idle" unread={false} />)
    expect(idle).toContain('size-4 shrink-0')
    expect(idle).not.toContain('aria-label')
    const running = renderToStaticMarkup(<SessionStatusIndicator status="running" unread />)
    expect(running).toContain('正在回复')
    expect(running).toContain('motion-reduce:animate-none')
    expect(running).not.toContain('bg-blue-500')
    const unread = renderToStaticMarkup(<SessionStatusIndicator status="complete" unread />)
    expect(unread).toContain('有未读回复')
    expect(unread).toContain('size-[7px]')
  })
  it('distinguishes waiting for input and failure from success', () => {
    expect(renderToStaticMarkup(<SessionStatusIndicator status="awaiting_input" unread={false} />)).toContain('等待你的回答')
    expect(renderToStaticMarkup(<SessionStatusIndicator status="error" unread />)).not.toContain('bg-blue-500')
  })
})
