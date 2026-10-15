import { useState } from 'react'
import type { PiConfigDocument, PiConfigurationUpdate, PiConfigScope } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog'

export const settingsInputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'
const json = (value: unknown) => JSON.stringify(value, null, 2)
const secret = '••••（保留已配置值）'
export function SettingsEntryEditor({ category, document, scope, busy, onDirty, onSave, guard }: {
  category: 'custom-models' | 'mcp'; document: PiConfigDocument; scope: PiConfigScope; busy: boolean
  onDirty: (dirty: boolean) => void; onSave: (update: PiConfigurationUpdate) => Promise<void>; guard: (action: () => void) => void
}) {
  const initialName = Object.keys(document.entries)[0] ?? ''
  const [selected, setSelected] = useState(initialName)
  const [name, setName] = useState(initialName)
  const [value, setValue] = useState<Record<string, unknown>>(document.entries[initialName] ?? (category === 'mcp' ? { command: '', args: [], enabled: true } : { api: 'openai-completions', models: [{ id: '' }] }))
  const [advanced, setAdvanced] = useState(json(value))
  const [modelJson, setModelJson] = useState(json(value.models ?? []))
  const [error, setError] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const models = category === 'custom-models'
  function choose(next: string) {
    setSelected(next); setName(next)
    const initial = document.entries[next] ?? (models ? { api: 'openai-completions', models: [{ id: '' }] } : { command: '', args: [], enabled: true })
    setValue(initial); setAdvanced(json(initial)); setModelJson(json(initial.models ?? [])); setError(undefined); onDirty(false)
  }
  function patch(next: Record<string, unknown>) {
    const updated = { ...value, ...next }
    setValue(updated); setAdvanced(json(updated)); onDirty(true); setError(undefined)
  }
  const transport = value.url !== undefined || value.type === 'http' || value.type === 'streamable-http' ? 'http' : 'stdio'
  function changeTransport(next: string) {
    const updated = { ...value }
    for (const key of ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth', 'auth']) delete updated[key]
    Object.assign(updated, next === 'http' ? { url: '', type: 'http' } : { command: '', args: [], type: 'stdio' })
    setValue(updated); setAdvanced(json(updated)); onDirty(true)
  }
  function textField(key: string, label: string, hint?: string, password = false) {
    return <label className="grid gap-2"><span className="text-sm font-medium">{label}</span><input className={settingsInputClass} type={password ? 'password' : 'text'} value={String(value[key] ?? '')} placeholder={hint} onChange={(event) => patch({ [key]: event.target.value || undefined })} autoComplete="off" />{hint && <span className="text-xs text-muted-foreground">{hint}</span>}</label>
  }
  async function save(remove = false) {
    try {
      const parsed: unknown = JSON.parse(advanced)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须是 JSON 对象')
      await onSave({ category, scope, revision: document.revision, name, value: remove ? null : parsed as Record<string, unknown> })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '配置无效') }
  }
  return <div className="space-y-6">
    <label className="grid gap-2"><span className="text-sm font-medium">{models ? '提供商' : 'MCP 服务'}</span><select className={settingsInputClass} value={selected} disabled={busy} onChange={(event) => { const next = event.target.value; guard(() => choose(next)) }}><option value="">＋ 新增{models ? '提供商' : '服务'}</option>{Object.keys(document.entries).map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
        <label className="grid gap-2"><span className="text-sm font-medium">{models ? 'Provider ID' : '服务名称'}</span><input className={settingsInputClass} required pattern="[a-zA-Z0-9_-]+" maxLength={128} disabled={Boolean(selected)} value={name} onChange={(event) => { setName(event.target.value); setError(undefined); onDirty(true) }} /><span className="text-xs text-muted-foreground">使用字母、数字、下划线或连字符。</span></label>
        {models ? <>
          {textField('baseUrl', 'Base URL', '例如 http://localhost:11434/v1；内置提供商覆盖可留空')}
          {textField('api', 'API 协议', '例如 openai-completions、openai-responses、anthropic-messages')}
          {textField('apiKey', 'API Key / 环境变量引用', '可使用 ${NAME}；保留标记表示沿用已有值。', true)}
          <label className="grid gap-2"><span className="text-sm font-medium">模型定义</span><Textarea className="min-h-40 font-mono text-xs" value={modelJson} onChange={(event) => { setModelJson(event.target.value); onDirty(true); try { const next: unknown = JSON.parse(event.target.value); if (!Array.isArray(next)) throw new Error(); patch({ models: next }) } catch { setError('模型定义需要有效的 JSON 数组；复杂编辑请使用下方高级配置。') } }} /><span className="text-xs text-muted-foreground">每个模型填写 id；可设置 name、reasoning、contextWindow、maxTokens、input、cost、compat。</span></label>
        </> : <>
          <label className="grid gap-2"><span className="text-sm font-medium">传输方式</span><select className={settingsInputClass} value={transport} onChange={(event) => changeTransport(event.target.value)}><option value="stdio">本地进程（stdio）</option><option value="http">远程服务（Streamable HTTP）</option></select></label>
          {transport === 'stdio' ? <>{textField('command', '可执行命令', '例如 npx 或 uvx；参数单独填写。')}{textField('cwd', '工作目录', '留空时使用会话目录。')}</> : textField('url', '服务 URL', '例如 https://example.com/mcp')}
          {textField('description', '说明')}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled !== false} onChange={(event) => patch({ enabled: event.target.checked })} />启用服务</label>
          <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2"><span className="text-sm font-medium">工具曝光方式</span><select className={settingsInputClass} value={String(value.exposure ?? 'codemode')} onChange={(event) => patch({ exposure: event.target.value })}>{['codemode', 'deferred', 'direct', 'hidden'].map((mode) => <option key={mode}>{mode}</option>)}</select></label><label className="grid gap-2"><span className="text-sm font-medium">请求超时（秒）</span><input className={settingsInputClass} type="number" min={1} max={3600} value={Number(value.timeout ?? 60)} onChange={(event) => patch({ timeout: Number(event.target.value) })} /></label></div>
        </>}
        <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">高级配置（JSON）</summary><p className="my-3 text-xs leading-5 text-muted-foreground">编辑完整条目。MCP 的 args、env、headers、oauth、toolExposure 在这里配置。{secret} 为密钥保留标记，删除字段或替换内容会修改原值。命令和扩展会在后续 Pi 运行中执行。</p><Textarea aria-label="完整条目 JSON" className="min-h-64 font-mono text-xs" spellCheck={false} value={advanced} onChange={(event) => { const text = event.target.value; setAdvanced(text); onDirty(true); try { const next: unknown = JSON.parse(text); if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error(); setValue(next as Record<string, unknown>); setModelJson(json((next as Record<string, unknown>).models ?? [])); setError(undefined) } catch { setError('高级配置需要有效的 JSON 对象') } }} /></details>
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-3"><Button type="submit" disabled={busy || !name || Boolean(error)}>{busy ? '正在保存…' : '保存配置'}</Button>{selected && <Button type="button" variant="destructive" disabled={busy} onClick={() => setDeleting(true)}>删除{models ? '提供商' : '服务'}</Button>}</div>
    </form>
    <AlertDialog open={deleting} onOpenChange={setDeleting}><AlertDialogContent><AlertDialogTitle>删除 {selected}？</AlertDialogTitle><AlertDialogDescription>这会删除{scope === 'global' ? '全局' : '项目'}中的配置条目。删除项目覆盖后，可能重新使用同名全局配置。</AlertDialogDescription><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setDeleting(false)}>取消</Button><Button variant="destructive" onClick={() => { setDeleting(false); void save(true) }}>删除</Button></div></AlertDialogContent></AlertDialog>
  </div>
}
