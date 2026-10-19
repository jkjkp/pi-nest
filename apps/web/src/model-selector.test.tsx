import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ModelSelector } from './model-selector.js'

vi.mock('radix-ui', () => {
  const Container = ({ children }: { children?: ReactNode }) => <>{children}</>
  const Content = ({ children, className }: { children?: ReactNode; className?: string }) => <div className={className}>{children}</div>
  return { Popover: { Root: Container, Trigger: Container, Portal: Container, Content } }
})

const models = [{ provider: 'fixture', id: 'one', name: 'Model One' }]
function render(status: 'loading' | 'ready' | 'error', options = models) {
  return renderToStaticMarkup(<ModelSelector open label="one" title="one" disabled={false} models={options} currentModel={{ provider: 'fixture', id: 'one' }} status={status} error={status === 'error' ? '读取失败' : undefined} isActive={false} onLoad={() => undefined} onRetry={() => undefined} onSelect={async () => true} />)
}

it('uses a stable outer height for initial loading, lists, empty results and failure', () => {
  for (const markup of [render('loading', []), render('ready'), render('ready', []), render('error', [])]) {
    expect(markup).toContain('h-[min(360px,var(--radix-popover-content-available-height))]')
    expect(markup).toContain('min-h-0 flex-1 overflow-y-auto')
  }
  expect(render('loading', [])).toContain('aria-busy="true"')
  expect(render('error', [])).toContain('role="alert"')
})

it('retains cached choices during refresh without adding a loading footer', () => {
  const markup = render('loading')
  expect(markup).toContain('Model One')
  expect(markup).not.toContain('aria-busy="true"')
  expect(markup).not.toContain('正在读取模型…')
  expect(markup).toContain('animate-spin')
})

it('exposes the full current model name when the trigger text is abbreviated', () => {
  expect(render('ready')).toContain('aria-label="选择模型：one"')
})
