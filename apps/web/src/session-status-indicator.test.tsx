import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionStatusIndicator } from './session-status-indicator.js'

describe('sidebar status', () => {
  it('releases empty status space and makes active work take priority over unread replies', () => {
    const idle = renderToStaticMarkup(<SessionStatusIndicator status="idle" unread={false} />)
    expect(idle).toBe('')
    const running = renderToStaticMarkup(<SessionStatusIndicator status="running" unread />)
    expect(running).toContain('正在回复')
    expect(running).toContain('motion-reduce:animate-none')
    expect(running).toContain('animation-duration:1.8s')
    expect(running).toContain('stroke-muted-foreground/20')
    expect(running).toContain('stroke-foreground/80')
    expect(running).toContain('stroke-dasharray="28.274 9.425"')
    expect(running).not.toContain('bg-blue-500')
    const unread = renderToStaticMarkup(<SessionStatusIndicator status="complete" unread />)
    expect(unread).toContain('有未读回复')
    expect(unread).toContain('size-[7px]')
  })
  it.each(['submitted', 'awaiting_agent', 'running', 'aborting'] as const)('rotates throughout %s', (status) => {
    expect(renderToStaticMarkup(<SessionStatusIndicator status={status} unread={false} />)).toContain('animate-spin')
  })
  it('distinguishes waiting for input and failure from success', () => {
    expect(renderToStaticMarkup(<SessionStatusIndicator status="awaiting_input" unread={false} />)).toContain('等待你的回答')
    expect(renderToStaticMarkup(<SessionStatusIndicator status="error" unread />)).not.toContain('bg-blue-500')
  })
})
