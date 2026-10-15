import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ProviderSelector } from './provider-selector.js'
import { filterModels } from './model-search.js'
vi.mock('radix-ui', () => {
  const Container = ({ children }: { children?: ReactNode }) => <>{children}</>
  return { Popover: { Root: Container, Trigger: Container, Portal: Container, Content: Container } }
})
it('shows the search input and accessible provider options with the saved selection', () => {
  const html = renderToStaticMarkup(<ProviderSelector providers={[{ id: 'anthropic', name: 'Anthropic' }, { id: 'amazon-bedrock', name: 'Amazon Bedrock' }]} value="anthropic" onValueChange={() => undefined} />)
  expect(html).toContain('aria-label="搜索提供商"')
  expect(html).toContain('placeholder="搜索名称或 Provider ID…"')
  expect(html).toContain('role="listbox"')
  expect(html).toContain('aria-selected="true"')
  expect(html).toContain('Amazon Bedrock')
})
it('matches provider display names and ids case-insensitively using the existing search', () => {
  const providers = [{ id: 'amazon-bedrock', name: 'Amazon Bedrock', provider: 'amazon-bedrock' }, { id: 'anthropic', name: 'Anthropic', provider: 'anthropic' }]
  expect(filterModels(providers, 'BEDROCK').map((provider) => provider.id)).toEqual(['amazon-bedrock'])
  expect(filterModels(providers, 'amazon-bedrock').map((provider) => provider.id)).toEqual(['amazon-bedrock'])
  expect(filterModels(providers, ' anth ')).toHaveLength(1)
  expect(filterModels(providers, 'unknown')).toHaveLength(0)
  expect(filterModels(providers, '  ')).toHaveLength(2)
})
