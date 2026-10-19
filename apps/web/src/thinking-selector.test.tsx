import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ThinkingSelector } from './thinking-selector.js'

vi.mock('radix-ui', () => {
  const Container = ({ children }: { children?: ReactNode }) => <>{children}</>
  return { Popover: { Root: Container, Trigger: Container, Portal: Container, Content: ({ children, className }: { children?: ReactNode; className?: string }) => <div className={className}>{children}</div> }, Portal: { Root: Container } }
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


it('keeps the same outer height for loading, loaded choices and read errors', () => {
  for (const markup of [render('loading', []), render('switching', ['off', 'low', 'medium', 'high', 'xhigh']), render('error', [], 'failure')]) {
    expect(markup).toContain('h-[min(280px,var(--radix-popover-content-available-height))]')
    expect(markup).toContain('min-h-0 flex-1 overflow-y-auto')
  }
  expect(render('loading', ['low', 'high'])).toContain('aria-pressed=')
  expect(render('loading', ['low', 'high'])).not.toContain('aria-busy="true"')
})

it('exposes the selected thinking level independently of its visible prefix', () => {
  expect(render('switching', ['medium'])).toContain('aria-label="选择思考等级：中"')
})
