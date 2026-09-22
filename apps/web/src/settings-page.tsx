import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'

import { fetchSessionSettings, saveSessionSettings, type PiRuntimeSettings } from './workspace-api.js'

const fields: (keyof PiRuntimeSettings)[] = ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'steeringMode', 'followUpMode', 'compactionEnabled', 'retryEnabled']

export function SettingsPage() {
  const [params] = useSearchParams()
  const sessionId = params.get('session') ?? ''
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof fetchSessionSettings>>>()
  const [draft, setDraft] = useState<Partial<PiRuntimeSettings>>({})
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!sessionId) return
    void fetchSessionSettings(sessionId).then((value) => { setSettings(value); setDraft(value.global) }).catch((cause) => setError(cause instanceof Error ? cause.message : '无法读取 Pi 设置'))
  }, [sessionId])

  if (!sessionId) return <main className="p-6"><p>请选择一个 Pi 会话后再打开设置。</p><Button asChild className="mt-4"><Link to="/">返回</Link></Button></main>
  return <main className="mx-auto max-w-3xl space-y-6 p-6"><header className="flex items-center gap-3"><Button asChild variant="ghost"><Link to={`/?session=${encodeURIComponent(sessionId)}`}>返回会话</Link></Button><h1 className="text-xl font-semibold">Pi 原生设置</h1></header>
    {error && <p className="text-destructive" role="alert">{error}</p>}
    {!settings ? <p>正在读取设置…</p> : <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); setError(undefined); void saveSessionSettings(sessionId, draft).then((value) => { setSettings(value); setDraft(value.global) }).catch((cause) => setError(cause instanceof Error ? cause.message : '无法保存 Pi 设置')) }}>
      <section className="space-y-3 rounded-lg border p-4"><h2 className="font-medium">Global（可编辑）</h2><p className="text-sm text-muted-foreground">保存会关闭空闲 Pi RuntimeHost；下次运行按 Pi 原生规则加载新配置。</p>{fields.map((field) => typeof settings.global[field] === 'boolean' ? <label className="flex gap-2" key={field}><input checked={Boolean(draft[field])} onChange={(event) => setDraft({ ...draft, [field]: event.target.checked })} type="checkbox" />{field}</label> : <label className="grid gap-1" key={field}><span>{field}</span><input className="rounded border bg-background px-2 py-1" onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} value={String(draft[field] ?? '')} /></label>)}</section>
      <section className="space-y-2 rounded-lg border p-4"><h2 className="font-medium">Project（只读）</h2><p className="text-sm text-muted-foreground">Pi 0.86.0 的公开 SettingsManager 未提供这些运行设置的项目级 setter。</p><pre className="overflow-auto text-xs">{JSON.stringify(settings.project, null, 2)}</pre></section>
      <section className="space-y-2 rounded-lg border p-4"><h2 className="font-medium">Effective（只读）</h2><pre className="overflow-auto text-xs">{JSON.stringify(settings.effective, null, 2)}</pre></section>
      <Button type="submit">保存全局设置</Button>
    </form>}
  </main>
}
