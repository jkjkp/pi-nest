import type { PiRuntimeModel } from '@pi-nest/contracts'

const providerAliases: Record<string, string> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek 深度求索',
  google: 'Google 谷歌',
  openai: 'OpenAI Open AI',
  moonshot: 'Moonshot 月之暗面 Kimi',
  qwen: 'Qwen 通义千问 阿里',
  dashscope: 'DashScope 通义千问 阿里',
  zai: 'Z.ai 智谱 Zhipu',
  zhipu: 'Zhipu 智谱 Z.ai',
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

export function filterModels(models: PiRuntimeModel[], search: string) {
  const terms = search.trim().split(/\s+/).map(normalize).filter(Boolean)
  return models.filter((model) => {
    const provider = model.provider.toLowerCase().split('-')[0]!
    const fields = [model.name ?? '', model.id, model.provider, providerAliases[provider] ?? ''].map(normalize)
    return terms.every((term) => fields.some((field) => field.includes(term)))
  }).sort((a, b) => a.provider.localeCompare(b.provider))
}
