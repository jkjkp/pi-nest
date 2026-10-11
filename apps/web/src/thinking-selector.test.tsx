import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ThinkingSelector } from './thinking-selector.js'

vi.mock('radix-ui', () => {
  const Container = ({ children }: { children?: ReactNode }) => <>{children}</>
  return { Popover: { Root: Container, Trigger: Container, Portal: Container, Content: Container }, Portal: { Root: Container } }
})

function render(status: 'switching' | 'loading' | 'error', levels: string[], error?: string) {
  return renderToStaticMarkup(<ThinkingSelector open onOpenChange={() => undefined} current="medium" levels={levels} status={status} error={error} failure={0} disabled={false} isActive={false} onLoad={() => undefined} onRetry={() => undefined} onSelect={async () => false} />)
}

it('keeps switching silent and disables choices without adding a status row', () => {
  const markup = render('switching', ['low', 'medium', 'high'])
  expect(markup).not.toContain('正在确认')
  expect(markup).not.toContain('role="status"')
  expect(markup).toContain('aria-pressed="true" disabled=""')
})

it('shows a skeleton on the initial read and a retry on read failure', () => {
  expect(render('loading', [])).toContain('aria-busy="true"')
  const failure = render('error', [], 'Internal RPC failure')
  expect(failure).toContain('读取失败，请重试。')
  expect(failure).toContain('重试</button>')
  expect(failure).not.toContain('Internal RPC failure')
})
