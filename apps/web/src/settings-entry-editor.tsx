import { useEffect, useState } from 'react'
import type { PiConfigDocument, PiConfigurationUpdate, PiConfigScope } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { jsonDraftChanged, settingsEqual } from './settings-model.js'
import { Textarea } from '@/components/ui/textarea'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog'

export const settingsInputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'
const json = (value: unknown) => JSON.stringify(value, null, 2)
const secret = '••••（保留已配置值）'
export function SettingsEntryEditor({ category, document, scope, busy, onDirty, onSave }: {
  category: 'custom-models' | 'mcp'; document: PiConfigDocument; scope: PiConfigScope; busy: boolean
  onDirty: (dirty: boolean) => void; onSave: (update: PiConfigurationUpdate) => Promise<void>
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [deleting, setDeleting] = useState<string>()
  const [error, setError] = useState<string>()
  const models = category === 'custom-models'
  const noun = models ? '提供商' : '服务'
  useEffect(() => onDirty(dirty), [dirty, onDirty])
  function close() { setEditing(null); setDirty(false); setConfirmClose(false) }
  async function remove() {
    if (!deleting) return
    try { await onSave({ category, scope, revision: document.revision, name: deleting, value: null }); setDeleting(undefined) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败'); setDeleting(undefined) }
  }
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium">{models ? '提供商列表' : '服务列表'}</h3><Button disabled={busy} onClick={() => setEditing('')}>＋ 新增{noun}</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {Object.keys(document.entries).length === 0 ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">尚未配置{noun}，点击“新增{noun}”填写配置。</div> : <ul className="divide-y rounded-lg border">{Object.entries(document.entries).map(([name, value]) => <li key={name} className="flex flex-wrap items-center justify-between gap-4 p-4"><div className="min-w-0"><p className="break-all text-sm font-medium">{name}</p><p className="mt-1 text-xs text-muted-foreground">{models ? String(value.api ?? '原生协议') : `${value.url ? 'HTTP' : value.command ? '本地进程' : '项目覆盖'} · ${value.enabled === false ? '已停用' : '已启用'}`}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(name)}>编辑<span className="sr-only"> {name}</span></Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(name)}>删除<span className="sr-only"> {name}</span></Button></div></li>)}</ul>}
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !busy) { if (dirty) setConfirmClose(true); else close() } }}><DialogContent className="max-h-[85dvh] w-[min(42rem,calc(100vw-2rem))] overflow-y-auto"><div className="mb-6 flex items-start justify-between gap-4"><div><DialogTitle>{editing ? '编辑' : '新增'}{noun}</DialogTitle><DialogDescription>保存到{scope === 'global' ? '全局' : '当前项目'} Pi 配置。</DialogDescription></div><Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (dirty) setConfirmClose(true); else close() }}>取消</Button></div>{editing !== null && <EntryForm key={editing} category={category} document={document} scope={scope} selected={editing} busy={busy} onDirty={setDirty} onSave={async (update) => { await onSave(update); close() }} />}</DialogContent></Dialog>
    <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}><AlertDialogContent><AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle><AlertDialogDescription>关闭表单会丢失当前修改。</AlertDialogDescription><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirmClose(false)}>继续编辑</Button><Button onClick={close}>放弃修改</Button></div></AlertDialogContent></AlertDialog>
    <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!busy && !open) setDeleting(undefined) }}><AlertDialogContent><AlertDialogTitle>删除 {deleting}？</AlertDialogTitle><AlertDialogDescription>删除{scope === 'global' ? '全局' : '项目'}条目。删除项目覆盖后，可能重新使用同名全局配置。</AlertDialogDescription><div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setDeleting(undefined)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>删除</Button></div></AlertDialogContent></AlertDialog>
  </div>
}

function EntryForm({ category, document, scope, selected, busy, onDirty, onSave }: {
  category: 'custom-models' | 'mcp'; document: PiConfigDocument; scope: PiConfigScope; selected: string; busy: boolean
  onDirty: (dirty: boolean) => void; onSave: (update: PiConfigurationUpdate) => Promise<void>
}) {
  const initial = document.entries[selected] ?? (category === 'mcp' ? { args: [], enabled: true } : { api: 'openai-completions', models: [{ id: '' }] })
  const [name, setName] = useState(selected)
  const [value, setValue] = useState<Record<string, unknown>>(initial)
  const [advanced, setAdvanced] = useState(json(value))
  const [modelJson, setModelJson] = useState(json(value.models ?? []))
  const [error, setError] = useState<string>()
  const models = category === 'custom-models'
  const duplicateName = !selected && Object.hasOwn(document.entries, name)
  const invalidModelJson = models && jsonDraftChanged(value.models ?? [], modelJson)
  const dirty = name !== selected || jsonDraftChanged(initial, advanced) || invalidModelJson
  let validJson = false
  try { const parsed: unknown = JSON.parse(advanced); validJson = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)) } catch { /* Keep invalid input editable. */ }
  useEffect(() => onDirty(dirty), [dirty, onDirty])
  function patch(next: Record<string, unknown>) {
    const updated = { ...value, ...next }
    if (!models) {
      const defaults: Record<string, unknown> = { enabled: true, exposure: 'codemode', timeout: 60 }
      for (const key of Object.keys(next)) if (initial[key] === undefined && settingsEqual(next[key], defaults[key])) delete updated[key]
    }
    setValue(updated); setAdvanced(json(updated)); setError(undefined)
  }
  const transport = value.url !== undefined || value.type === 'http' || value.type === 'streamable-http' ? 'http' : 'stdio'
  function changeTransport(next: string) {
    const updated = { ...value }
    for (const key of ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth', 'auth']) delete updated[key]
    const originalTransport = initial.url !== undefined || initial.type === 'http' || initial.type === 'streamable-http' ? 'http' : 'stdio'
    const transportKeys = ['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth', 'auth']
    Object.assign(updated, next === originalTransport
      ? Object.fromEntries(transportKeys.filter((key) => initial[key] !== undefined).map((key) => [key, initial[key]]))
      : next === 'http' ? { url: '', type: 'http' } : { args: [], type: 'stdio' })
    setValue(updated); setAdvanced(json(updated))
  }
  function textField(key: string, label: string, hint?: string, password = false) {
    return <label className="grid gap-2"><span className="text-sm font-medium">{label}</span><input className={settingsInputClass} type={password ? 'password' : 'text'} value={String(value[key] ?? '')} placeholder={hint} onChange={(event) => patch({ [key]: event.target.value || undefined })} autoComplete="off" />{hint && <span className="text-xs text-muted-foreground">{hint}</span>}</label>
  }
  async function save() {
    if (!dirty || !validJson || invalidModelJson || duplicateName) return
    try {
      const parsed: unknown = JSON.parse(advanced)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须是 JSON 对象')
      await onSave({ category, scope, revision: document.revision, name, value: parsed as Record<string, unknown> })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '配置无效') }
  }
  return <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
        <label className="grid gap-2"><span className="text-sm font-medium">{models ? 'Provider ID' : '服务名称'}</span><input className={settingsInputClass} required pattern="[a-zA-Z0-9_-]+" maxLength={128} disabled={Boolean(selected)} value={name} onChange={(event) => { setName(event.target.value); setError(undefined) }} /><span className="text-xs text-muted-foreground">使用字母、数字、下划线或连字符。</span></label>
        {models ? <>
          {textField('baseUrl', 'Base URL', '例如 http://localhost:11434/v1；内置提供商覆盖可留空')}
          {textField('api', 'API 协议', '例如 openai-completions、openai-responses、anthropic-messages')}
          {textField('apiKey', 'API Key / 环境变量引用', '可使用 ${NAME}；保留标记表示沿用已有值。', true)}
          <label className="grid gap-2"><span className="text-sm font-medium">模型定义</span><Textarea className="min-h-40 font-mono text-xs" value={modelJson} onChange={(event) => { setModelJson(event.target.value); try { const next: unknown = JSON.parse(event.target.value); if (!Array.isArray(next)) throw new Error(); patch({ models: next }) } catch { setError('模型定义需要有效的 JSON 数组；复杂编辑请使用下方高级配置。') } }} /><span className="text-xs text-muted-foreground">每个模型填写 id；可设置 name、reasoning、contextWindow、maxTokens、input、cost、compat。</span></label>
        </> : <>
          <label className="grid gap-2"><span className="text-sm font-medium">传输方式</span><Select label="传输方式" value={transport} options={[{ value: 'stdio', label: '本地进程（stdio）' }, { value: 'http', label: '远程服务（Streamable HTTP）' }]} onValueChange={changeTransport} disabled={busy} /></label>
          {transport === 'stdio' ? <>{textField('command', '可执行命令', '例如 npx 或 uvx；参数单独填写。')}{textField('cwd', '工作目录', '留空时使用会话目录。')}</> : textField('url', '服务 URL', '例如 https://example.com/mcp')}
          {textField('description', '说明')}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled !== false} onChange={(event) => patch({ enabled: event.target.checked })} />启用服务</label>
          <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2"><span className="text-sm font-medium">工具曝光方式</span><Select label="工具曝光方式" value={String(value.exposure ?? 'codemode')} options={['codemode', 'deferred', 'direct', 'hidden'].map((mode) => ({ value: mode, label: mode }))} onValueChange={(exposure) => patch({ exposure })} disabled={busy} /></label><label className="grid gap-2"><span className="text-sm font-medium">请求超时（秒）</span><input className={settingsInputClass} type="number" min={1} max={3600} value={Number(value.timeout ?? 60)} onChange={(event) => patch({ timeout: Number(event.target.value) })} /></label></div>
        </>}
        <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">高级配置（JSON）</summary><p className="my-3 text-xs leading-5 text-muted-foreground">编辑完整条目。MCP 的 args、env、headers、oauth、toolExposure 在这里配置。{secret} 为密钥保留标记，删除字段或替换内容会修改原值。命令和扩展会在后续 Pi 运行中执行。</p><Textarea aria-label="完整条目 JSON" className="min-h-64 font-mono text-xs" spellCheck={false} value={advanced} onChange={(event) => { const text = event.target.value; setAdvanced(text); try { const next: unknown = JSON.parse(text); if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error(); setValue(next as Record<string, unknown>); setModelJson(json((next as Record<string, unknown>).models ?? [])); setError(undefined) } catch { setError('高级配置需要有效的 JSON 对象') } }} /></details>
      </fieldset>
      {(error || duplicateName) && <p role="alert" className="text-sm text-destructive">{duplicateName ? '名称已存在，请关闭弹窗后编辑已有条目。' : error}</p>}
      <div className="flex gap-3"><Button type="submit" disabled={busy || !dirty || !name || !validJson || invalidModelJson || duplicateName}>{busy ? '正在保存…' : '保存配置'}</Button></div>
    </form>
}
