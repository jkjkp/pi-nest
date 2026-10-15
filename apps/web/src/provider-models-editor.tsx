import { useState } from 'react'
import type { PiCatalogModel, PiDiscoveredModel, PiModelDiscoveryRequest } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { ProviderSelector } from './provider-selector.js'
import { discoverProviderModels } from './workspace-api.js'
import { addProviderModels, providerModelRows } from './provider-models.js'

const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'
export function ProviderModelsEditor({ provider, connection, models, baseline, catalog, providers, inherit, onChange }: {
  provider: string; connection: Record<string, unknown>; models: unknown; baseline: unknown; catalog: PiCatalogModel[]
  providers: { id: string; name: string }[]; inherit: boolean; onChange: (models: unknown) => void
}) {
  const rows = providerModelRows(models)
  const [source, setSource] = useState(catalog.some((model) => model.provider === provider) ? provider : catalog[0]?.provider ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [discovered, setDiscovered] = useState<{ fingerprint: string; models: PiDiscoveredModel[] }>()
  const fingerprint = JSON.stringify([provider, connection.baseUrl, connection.api, connection.apiKey, connection.headers])
  const supported = ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(String(connection.api))
  function add(additions: (PiDiscoveredModel | PiCatalogModel)[]) {
    const result = addProviderModels(rows ?? [], additions)
    if (result.length > 512) { setError('最多配置 512 个模型，请减少选择。'); return }
    onChange(result); setError(undefined)
  }
  async function discover() {
    setLoading(true); setError(undefined)
    try {
      const result = await discoverProviderModels({ provider, connection: { baseUrl: String(connection.baseUrl), api: connection.api as PiModelDiscoveryRequest['connection']['api'], ...(typeof connection.apiKey === 'string' ? { apiKey: connection.apiKey } : {}), ...(connection.headers ? { headers: connection.headers as Record<string, string> } : {}) } })
      setDiscovered({ fingerprint, models: result.models })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '获取失败，请手动添加模型。') }
    finally { setLoading(false) }
  }
  function patch(index: number, field: string, value: unknown) {
    if (!rows) return
    const original = providerModelRows(baseline)?.find((model) => model.id === rows[index].id)
    onChange(rows.map((model, position) => position === index ? { ...model, [field]: field === 'reasoning' && value === false && original?.reasoning === undefined ? undefined : value } : model))
  }
  const availableProviders = providers.filter((item) => catalog.some((model) => model.provider === item.id))
  return <section className="space-y-4 rounded-lg border p-4">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">模型</h3><Button type="button" size="sm" variant="outline" disabled={!rows || rows.length >= 512} onClick={() => onChange([...(rows ?? []), { id: '' }])}>＋ 添加模型</Button></div>
    <p className="text-xs leading-5 text-muted-foreground">{inherit ? '不添加模型时沿用该提供商的 Pi 模型目录；可在此补充或覆盖模型。' : '手动添加只需模型 ID；也可以从 Pi 目录或端点列表导入。'}</p>
    {!rows ? <p role="alert" className="text-sm text-destructive">模型格式无效，请在高级 JSON 中修正。</p> : rows.map((model, index) => <div key={index} className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">模型 {index + 1}</span><Button type="button" variant="ghost" size="sm" aria-label={`删除模型 ${index + 1}`} onClick={() => onChange(rows.filter((_, position) => position !== index))}>删除</Button></div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">模型 ID<input className={inputClass} aria-label={`模型 ID ${index + 1}`} required value={model.id} placeholder="服务商提供的模型标识" onChange={(event) => patch(index, 'id', event.target.value)} /></label><label className="grid gap-1 text-sm">显示名称（选填）<input className={inputClass} aria-label={`模型名称 ${index + 1}`} value={String(model.name ?? '')} onChange={(event) => patch(index, 'name', event.target.value || undefined)} /></label></div>
      <details className="text-sm"><summary className="cursor-pointer">高级参数</summary><div className="mt-3 space-y-3"><div className="grid gap-3 sm:grid-cols-2">{(['contextWindow', 'maxTokens'] as const).map((field) => <label key={field} className="grid gap-1 text-xs">{field === 'contextWindow' ? '上下文长度（tokens）' : '最大输出（tokens）'}<input className={inputClass} type="number" min={1} step={1} aria-label={`${field} ${index + 1}`} placeholder="留空使用 Pi 默认值" value={typeof model[field] === 'number' ? model[field] : ''} onChange={(event) => patch(index, field, event.target.value ? Number(event.target.value) : undefined)} /></label>)}</div><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={model.reasoning === true} onChange={(event) => patch(index, 'reasoning', event.target.checked)} />支持 Thinking</label><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Array.isArray(model.input) && model.input.includes('image')} onChange={(event) => { const original = providerModelRows(baseline)?.find((row) => row.id === model.id); const input = event.target.checked ? [...new Set([...(Array.isArray(model.input) ? model.input : ['text']), 'image'])] : (Array.isArray(model.input) ? model.input.filter((item) => item !== 'image') : ['text']); patch(index, 'input', !event.target.checked && original?.input === undefined && input.length === 1 && input[0] === 'text' ? undefined : input) }} />支持图片输入</label><p className="text-xs leading-5 text-muted-foreground">Pi 默认值不代表端点的实际能力。图片输入、兼容参数等仍可在高级 JSON 中配置；已有字段会保留。</p></div></details>
    </div>)}
    <details><summary className="cursor-pointer text-sm font-medium">从 Pi 模型目录选择</summary><div className="mt-3 space-y-3"><ProviderSelector value={source} providers={availableProviders} onValueChange={setSource} /><p className="text-xs text-muted-foreground">导入目录中的模型 ID 和能力参数，请确认当前端点支持这些模型。</p><ModelChoices key={source} models={catalog.filter((model) => model.provider === source)} existing={(rows ?? []).map((model) => model.id)} onAdd={add} /></div></details>
    <details><summary className="cursor-pointer text-sm font-medium">从端点获取模型列表</summary><div className="mt-3 space-y-3"><p className="text-xs leading-5 text-muted-foreground">将当前表单的凭据发送到所填端点的模型列表接口（OpenAI /models，Anthropic /v1/models）。支持 OpenAI 兼容及 Anthropic 协议；只获取 ID，不推测能力，也不保存配置。</p><Button type="button" variant="outline" size="sm" disabled={!rows || loading || !provider || !connection.baseUrl || !supported} onClick={() => void discover()}>{loading ? '正在获取…' : '获取模型列表'}</Button>{!supported && <p className="text-xs text-muted-foreground">当前协议不支持自动获取，请使用 Pi 目录或手动添加。</p>}{discovered?.fingerprint === fingerprint && <ModelChoices key={fingerprint + JSON.stringify(discovered.models)} models={discovered.models} existing={(rows ?? []).map((model) => model.id)} onAdd={add} />}</div></details>
    {error && <p role="alert" className="text-sm text-destructive">{error} 已填写的配置会保留。</p>}
  </section>
}

function ModelChoices({ models, existing, onAdd }: { models: (PiDiscoveredModel | PiCatalogModel)[]; existing: string[]; onAdd: (models: (PiDiscoveredModel | PiCatalogModel)[]) => void }) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const filtered = models.filter((model) => `${model.id} ${model.name ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
  const additions = models.filter((model) => selected.includes(model.id) && !existing.includes(model.id))
  return <div className="space-y-2"><input className={inputClass} aria-label="搜索待添加模型" placeholder="搜索模型名称或 ID" value={search} onChange={(event) => setSearch(event.target.value)} /><div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">{filtered.map((model) => <label key={model.id} className="flex items-start gap-2 p-1 text-sm"><input className="mt-1" type="checkbox" checked={existing.includes(model.id) || selected.includes(model.id)} disabled={existing.includes(model.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, model.id] : selected.filter((id) => id !== model.id))} /><span className="min-w-0 break-all">{model.name ?? model.id}<span className="block text-xs text-muted-foreground">{model.id}{existing.includes(model.id) ? ' · 已添加' : ''}</span></span></label>)}{!filtered.length && <p className="p-2 text-xs text-muted-foreground">没有可选模型，请手动添加或调整搜索。</p>}</div><Button type="button" size="sm" variant="outline" disabled={!additions.length} onClick={() => { onAdd(additions); setSelected([]) }}>添加所选模型（{additions.length}）</Button></div>
}
