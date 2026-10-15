import type { PiCatalogModel, PiDiscoveredModel } from '@pi-nest/contracts'
export type ProviderModelDefinition = Record<string, unknown> & { id: string }

export function providerModelRows(value: unknown): ProviderModelDefinition[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string')) return undefined
  return value as ProviderModelDefinition[]
}

export function providerModelsError(value: unknown, inherit: boolean): string | undefined {
  const rows = providerModelRows(value)
  if (!rows) return '模型格式无效，请在高级 JSON 中修正为包含模型 ID 的数组。'
  if (!rows.length && !inherit) return '请添加至少一个模型，或从目录、端点列表中选择模型。'
  const ids = new Set<string>()
  for (const row of rows) {
    if (!row.id.trim()) return '请填写模型 ID，或删除空白模型。'
    if (ids.has(row.id)) return `模型 ID 重复：${row.id}`
    ids.add(row.id)
    for (const key of ['contextWindow', 'maxTokens']) if (row[key] !== undefined && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || Number(row[key]) <= 0)) return '上下文和最大输出长度必须为正数，或留空。'
  }
  return rows.length > 512 ? '最多配置 512 个模型。' : undefined
}

export function addProviderModels(current: ProviderModelDefinition[], additions: (PiDiscoveredModel | PiCatalogModel)[]): ProviderModelDefinition[] {
  const ids = new Set(current.map((model) => model.id))
  const result = [...current]
  for (const model of additions) {
    if (ids.has(model.id)) continue
    ids.add(model.id)
    result.push({ ...('definition' in model ? model.definition : {}), id: model.id, ...(model.name && model.name !== model.id ? { name: model.name } : {}) })
  }
  return result
}
