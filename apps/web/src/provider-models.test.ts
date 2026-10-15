import { expect, it } from 'vitest'
import { addProviderModels, providerModelRows, providerModelsError } from './provider-models.js'

it('requires only an id for custom models and allows built-in provider inheritance', () => {
  expect(providerModelsError([{ id: 'custom' }], false)).toBeUndefined()
  expect(providerModelsError(undefined, true)).toBeUndefined()
  expect(providerModelsError([], false)).toContain('至少一个')
  expect(providerModelsError([{ id: '' }], false)).toContain('模型 ID')
  expect(providerModelsError([{ id: 'same' }, { id: 'same' }], false)).toContain('重复')
  expect(providerModelsError([{ id: 'id', maxTokens: -1 }], false)).toContain('正数')
  expect(providerModelRows({ models: [] })).toBeUndefined()
  expect(providerModelRows([null])).toBeUndefined()
})
it('imports known metadata, keeps manually edited fields, and never invents remote metadata', () => {
  const current = [{ id: 'existing', compat: { custom: true }, contextWindow: 99 }]
  const merged = addProviderModels(current, [
    { id: 'existing', name: 'Duplicate', thinkingLevels: [], provider: 'source', definition: { contextWindow: 1000 } },
    { id: 'catalog', name: 'Catalog', thinkingLevels: [], provider: 'source', definition: { contextWindow: 128000, reasoning: true } },
    { id: 'remote' },
    { id: 'remote' },
  ])
  expect(merged).toEqual([current[0], { id: 'catalog', name: 'Catalog', contextWindow: 128000, reasoning: true }, { id: 'remote' }])
  expect(current).toHaveLength(1)
})
