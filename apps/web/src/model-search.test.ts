import { expect, it } from 'vitest'
import { filterModels } from './model-search.js'

const models = [
  { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
  { provider: 'zai-coding-cn', id: 'glm-5.3', name: 'GLM-5.3' },
  { provider: 'zai-coding-cn', id: 'glm-4.6v', name: 'GLM-4.6V' },
  { provider: 'custom-vendor', id: 'custom-model' },
]

it('matches provider IDs and vendor names independently of model names', () => {
  for (const query of ['zai-coding-cn', 'ZAI', 'Z.ai', '智谱', 'Zhipu']) {
    expect(filterModels(models, query).map((model) => model.id)).toEqual(['glm-5.3', 'glm-4.6v'])
  }
  expect(filterModels(models, '深度求索')).toEqual([models[0]])
  expect(filterModels(models, 'custom vendor')).toEqual([models[3]])
})

it('combines provider and model terms while preserving name and ID searches', () => {
  for (const query of ['智谱 5.3', 'glm-5.3', 'Z.AI GLM-5.3', '  zai   5.3  ']) {
    expect(filterModels(models, query)).toEqual([models[1]])
  }
  expect(filterModels(models, 'Flash')).toEqual([models[0]])
  expect(filterModels(models, '不存在')).toEqual([])
  expect(filterModels(models, '')).toHaveLength(4)
  expect(models[0]?.provider).toBe('deepseek')
})
