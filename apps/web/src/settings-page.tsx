import { ProjectSettings } from './project-settings.js'
import { useEffect, useState } from 'react'
import { Link, useBeforeUnload, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import type { PiAdvancedSettings, PiConfigurationSnapshot, PiConfigurationUpdate, PiConfigScope, PiMcpDiagnostics, PiResourceSettings, PiRuntimeSettings, PiSettingsCategory } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { changedSettings, settingsCategories, jsonDraftChanged, secondsToMilliseconds } from './settings-model.js'
import { fetchPiConfiguration, savePiConfiguration, testPiMcp } from './workspace-api.js'
import { ProviderSelector } from './provider-selector.js'
import { ModelSelector } from './model-selector.js'
import { SettingsEntryEditor, settingsInputClass } from './settings-entry-editor.js'

const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : '操作失败'

export function SettingsPage() {
  const { category: routeCategory } = useParams()
  const [params] = useSearchParams()
  const sessionId = params.get('session') ?? undefined
  const category = settingsCategories.find((item) => item.id === routeCategory) ?? settingsCategories[0]
  const projectManagement = category.id === 'projects'
  const navigate = useNavigate()
  const [snapshot, setSnapshot] = useState<PiConfigurationSnapshot>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [scope, setScope] = useState<PiConfigScope>('global')
  const [generation, setGeneration] = useState(0)
  const [pending, setPending] = useState<(() => void)>()
  const blocker = useBlocker(dirty)
  useBeforeUnload((event) => { if (dirty) { event.preventDefault(); event.returnValue = '' } })
  useEffect(() => {
    if (projectManagement) return
    let cancelled = false
    void fetchPiConfiguration(sessionId).then((value) => { if (!cancelled) setSnapshot(value) }).catch((cause) => { if (!cancelled) setError(messageOf(cause)) })
    return () => { cancelled = true }
  }, [sessionId, generation, projectManagement])
  function guard(action: () => void) {
    if (busy) return
    if (dirty) setPending(() => action)
    else action()
  }
  function go(id: string) {
    if (busy) return
    setNotice(undefined); setError(undefined)
    navigate(`/settings/${id}${sessionId ? `?${new URLSearchParams({ session: sessionId })}` : ''}`)
  }
  async function save(update: PiConfigurationUpdate) {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      await savePiConfiguration(update, sessionId)
      setDirty(false)
      setNotice('已保存到 Pi 原生配置。空闲运行实例已释放，下次运行加载新配置；已有会话保留自身的模型选择。')
      setSnapshot(undefined); setGeneration((value) => value + 1)
    } catch (cause) { setError(messageOf(cause)); throw cause }
    finally { setBusy(false) }
  }
  const scoped = category.id === 'mcp' || category.id === 'resources'
  const activeScope = scoped ? scope : 'global'
  return <main className="min-h-screen bg-background text-foreground">
    <header className="flex h-16 items-center justify-between gap-4 border-b px-4 sm:px-8"><div className="flex items-center gap-4"><Button asChild variant="ghost" size="sm"><Link to={sessionId ? `/?${new URLSearchParams({ session: sessionId })}` : '/'} onClick={(event) => { if (busy) event.preventDefault() }}><ArrowLeft aria-hidden="true" />返回会话</Link></Button><h1 className="text-lg font-semibold">设置</h1></div><span className="hidden text-xs text-muted-foreground sm:block">{projectManagement ? 'Pi Nest 项目' : 'Pi 原生配置'}</span></header>
    <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="border-b bg-muted/20 p-4 md:border-r md:border-b-0 md:p-6"><p className="mb-4 hidden text-xs font-medium tracking-wider text-muted-foreground md:block">配置分类</p><nav aria-label="设置分类" className="hidden space-y-1 md:block">{settingsCategories.map(({ id, label, icon: Icon }) => <Link key={id} to={`/settings/${id}${sessionId ? `?${new URLSearchParams({ session: sessionId })}` : ''}`} aria-current={category.id === id ? 'page' : undefined} onClick={(event) => { event.preventDefault(); go(id) }} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${category.id === id ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}`}><Icon size={17} aria-hidden="true" />{label}</Link>)}</nav><label className="grid gap-2 text-sm md:hidden"><span>设置分类</span><Select label="设置分类" value={category.id} options={settingsCategories.map(({ id, label }) => ({ value: id, label }))} onValueChange={go} /></label></aside>
      <section className="min-w-0 px-4 py-6 sm:px-8 md:p-10"><div className="max-w-3xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-2xl font-semibold tracking-tight">{category.label}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{category.description}</p></div>{!projectManagement && <Button variant="outline" size="sm" disabled={busy} onClick={() => guard(() => { setDirty(false); setSnapshot(undefined); setGeneration((value) => value + 1) })}>重新加载</Button>}</div>
        {scoped && <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3"><label className="flex items-center gap-3 text-sm"><span className="shrink-0 whitespace-nowrap">配置范围</span><Select label="配置范围" className="sm:w-36" value={scope} disabled={busy} options={[{ value: 'global', label: '全局' }, ...(sessionId ? [{ value: 'project', label: '当前项目' }] : [])]} onValueChange={(value) => guard(() => { setDirty(false); setScope(value as PiConfigScope) })} /></label><span className="text-xs text-muted-foreground">{scope === 'global' ? '对所有 Pi 会话生效' : snapshot?.projectTrusted ? '已在 Pi 中信任的项目' : '请先在 Pi CLI 中信任项目'}</span></div>}
        {!projectManagement && error && <p className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive" role="alert">{error}</p>}
        {!projectManagement && notice && <p className="rounded-lg border p-3 text-sm" role="status">{notice}</p>}
        {category.id === 'projects' ? <ProjectSettings /> : !snapshot ? !error && <p role="status" className="text-sm text-muted-foreground">正在读取 Pi 配置…</p> : activeScope === 'project' && !snapshot.projectTrusted ? <p className="rounded-lg border p-5 text-sm text-muted-foreground">该项目尚未被 Pi 信任，项目配置未加载。请在 Pi CLI 中完成信任操作后重新加载。</p> : <SettingsPanel key={`${category.id}:${activeScope}:${sessionId}:${generation}`} category={category.id} snapshot={snapshot} scope={activeScope} sessionId={sessionId} busy={busy} onDirty={setDirty} onSave={save} guard={guard} />}
      </div></section>
    </div>
    <AlertDialog open={Boolean(pending) || blocker.state === 'blocked'} onOpenChange={(open) => { if (!open) { setPending(undefined); if (blocker.state === 'blocked') blocker.reset() } }}><AlertDialogContent><AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle><AlertDialogDescription>当前分类的修改尚未保存，继续操作会丢失这些修改。</AlertDialogDescription><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => { setPending(undefined); if (blocker.state === 'blocked') blocker.reset() }}>继续编辑</Button><Button onClick={() => { const action = pending; setPending(undefined); setDirty(false); if (blocker.state === 'blocked') blocker.proceed(); else action?.() }}>放弃修改</Button></div></AlertDialogContent></AlertDialog>
  </main>
}

function SettingsPanel({ category, snapshot, scope, sessionId, busy, onDirty, onSave, guard }: {
  category: PiSettingsCategory; snapshot: PiConfigurationSnapshot; scope: PiConfigScope; sessionId?: string; busy: boolean
  onDirty: (dirty: boolean) => void; onSave: (update: PiConfigurationUpdate) => Promise<void>; guard: (action: () => void) => void
}) {
  const [runtime, setRuntime] = useState(snapshot.settings.global)
  const [advanced, setAdvanced] = useState(snapshot.advanced)
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(snapshot.advanced.httpIdleTimeoutMs / 1000))
  const [resources, setResources] = useState<Partial<PiResourceSettings>>(scope === 'project' ? snapshot.projectResources ?? {} : snapshot.resources)
  const [packages, setPackages] = useState(JSON.stringify(resources.packages ?? [], null, 2))
  const [provider, setProvider] = useState(snapshot.providers[0]?.id ?? '')
  const [apiKey, setApiKey] = useState('')
  const [removeCredential, setRemoveCredential] = useState(false)
  const [error, setError] = useState<string>()
  const [diagnostics, setDiagnostics] = useState<PiMcpDiagnostics>()
  const [testing, setTesting] = useState(false)
  function runtimePatch(patch: Partial<PiRuntimeSettings>) { setRuntime({ ...runtime, ...patch }) }
  function advancedPatch(patch: Partial<PiAdvancedSettings>) { setAdvanced({ ...advanced, ...patch }) }
  const runtimeBase = { ...snapshot.settings.effective, ...snapshot.settings.global, defaultThinkingLevel: snapshot.settings.global.defaultThinkingLevel ?? snapshot.settings.effective.defaultThinkingLevel ?? 'off' }
  const runtimeChanges = changedSettings(runtimeBase, { ...runtimeBase, ...runtime })
  const timeoutMs = secondsToMilliseconds(timeoutSeconds)
  const advancedChanges = changedSettings({ ...snapshot.advanced, enabledModels: snapshot.advanced.enabledModels ?? [] }, { ...advanced, enabledModels: advanced.enabledModels ?? [], httpIdleTimeoutMs: timeoutMs ?? snapshot.advanced.httpIdleTimeoutMs })
  const resourceBase: PiResourceSettings = { packages: [], extensions: [], skills: [], prompts: [], themes: [], ...Object.fromEntries(Object.entries(scope === 'project' ? snapshot.projectResources ?? {} : snapshot.resources).filter(([, value]) => value !== undefined)) }
  let resourceValues = { ...resourceBase, ...resources }
  try { resourceValues = { ...resourceBase, ...resources, packages: JSON.parse(packages) } } catch { /* Invalid drafts must remain protected. */ }
  const resourceChanges = changedSettings({ ...resourceBase, packages: resourceBase.packages ?? [] }, resourceValues)
  const dirty = category === 'models' ? Object.keys(runtimeChanges).length > 0
    : category === 'advanced' ? timeoutMs === undefined || Object.keys(advancedChanges).length > 0
    : category === 'resources' ? jsonDraftChanged(resourceBase.packages ?? [], packages) || Object.keys(resourceChanges).length > 0
    : category === 'credentials' ? Boolean(apiKey.trim()) : false
  useEffect(() => {
    if (category !== 'mcp' && category !== 'custom-models') onDirty(dirty)
  }, [category, dirty, onDirty])
  async function save(update: PiConfigurationUpdate) { try { setError(undefined); await onSave(update) } catch (cause) { setError(messageOf(cause)) } }
  const selectedModel = snapshot.models.find((model) => model.provider === (runtime.defaultProvider ?? snapshot.settings.effective.defaultProvider) && model.id === (runtime.defaultModel ?? snapshot.settings.effective.defaultModel))
  const selectedProvider = snapshot.providers.find((item) => item.id === provider)
  function selectField(label: string, value: string, options: readonly string[], onChange: (value: string) => void) {
    return <div className="grid gap-2"><span className="text-sm font-medium">{label}</span><Select label={label} value={value} onValueChange={onChange} disabled={busy} options={[...(!options.includes(value) && value ? [value] : []), ...options].map((item) => ({ value: item, label: item }))} /></div>
  }
  if (category === 'custom-models' || category === 'mcp') return <>
    {snapshot.errors?.[category === 'mcp' && scope === 'project' ? 'project-mcp' : category] && <p role="alert" className="rounded-lg border p-3 text-sm text-destructive">{snapshot.errors[category === 'mcp' && scope === 'project' ? 'project-mcp' : category]}</p>}
    {(category === 'custom-models' ? snapshot.customModels : scope === 'project' ? snapshot.projectMcp : snapshot.mcp)?.revision && <SettingsEntryEditor category={category} document={category === 'custom-models' ? snapshot.customModels : scope === 'project' ? snapshot.projectMcp! : snapshot.mcp} scope={scope} busy={busy || testing} onDirty={onDirty} onSave={onSave} catalog={snapshot.models} providers={snapshot.providers} />}
    {category === 'mcp' && <section className="space-y-3 rounded-lg border p-4"><h3 className="text-sm font-medium">连接诊断</h3><p className="text-xs leading-5 text-muted-foreground">测试已保存且已启用的全局及可信项目服务。会启动本地命令并访问远程服务，最长约 45 秒。OAuth 登录请使用 Pi 的 /mcp 或 pi mcp login；登录结果由原生 Pi 管理。</p><Button variant="outline" disabled={testing || busy} onClick={() => guard(() => { setTesting(true); setError(undefined); void testPiMcp(sessionId).then(setDiagnostics).catch((cause) => setError(messageOf(cause))).finally(() => setTesting(false)) })}>{testing ? '正在测试…' : '测试已保存的服务连接'}</Button>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{diagnostics && <div role="status" className="space-y-2 text-sm"><p>{diagnostics.hasErrors ? '部分服务连接失败，请用 pi mcp list 查看详细错误。' : '连接检查完成。'}</p>{diagnostics.servers.map((server) => <div key={server.name} className="rounded border p-3"><p>{server.name} · {server.state} · {server.tools.length} 个工具</p>{server.tools.length > 0 && <details className="mt-2 text-xs text-muted-foreground"><summary>工具列表</summary><ul className="mt-2 space-y-1">{server.tools.map((tool) => <li key={tool}>{tool}</li>)}</ul></details>}</div>)}</div>}</section>}
  </>
  return <form className="space-y-6" onSubmit={(event) => {
    event.preventDefault()
    if (!dirty) return
    if (category === 'models') { const values = runtimeChanges; if (Object.keys(values).length) void save({ category, values }) }
    if (category === 'advanced') { if (timeoutMs === undefined) return; const values = advancedChanges; if (Object.keys(values).length) void save({ category, values }) }
    if (category === 'credentials') void save({ category, provider, apiKey })
    if (category === 'resources') {
      try { JSON.parse(packages); const values = resourceChanges; if (Object.keys(values).length) void save({ category, scope, values }) }
      catch { setError('Packages 需要有效的 JSON 数组') }
    }
  }}>
    <fieldset disabled={busy || testing} className="space-y-6 disabled:opacity-60">
      {category === 'models' && <>
        <section className="space-y-4 rounded-xl border p-5"><h3 className="font-medium">默认模型</h3><p className="text-xs leading-5 text-muted-foreground">仅影响新会话默认值；当前会话的模型选择在会话中修改。目录也包含尚未配置认证的模型。</p><ModelSelector label={runtime.defaultModel ? `${runtime.defaultProvider} / ${runtime.defaultModel}` : '选择默认模型'} title="选择默认模型" disabled={busy} models={snapshot.models} currentModel={{ provider: runtime.defaultProvider, id: runtime.defaultModel }} status="ready" isActive={false} onLoad={() => undefined} onRetry={() => undefined} onSelect={async (defaultProvider, defaultModel) => { runtimePatch({ defaultProvider, defaultModel, defaultThinkingLevel: 'off' }); return true }} />{selectField('默认 Thinking', runtime.defaultThinkingLevel ?? snapshot.settings.effective.defaultThinkingLevel ?? 'off', selectedModel?.thinkingLevels.length ? selectedModel.thinkingLevels : ['off'], (defaultThinkingLevel) => runtimePatch({ defaultThinkingLevel }))}<p className="text-xs text-muted-foreground">当前上下文生效：{snapshot.settings.effective.defaultProvider ?? 'Pi 默认'} / {snapshot.settings.effective.defaultModel ?? '自动选择'}</p></section>
        <section className="space-y-4 rounded-xl border p-5"><h3 className="font-medium">运行行为</h3>{(['steeringMode', 'followUpMode'] as const).map((key) => <div key={key}>{selectField(key === 'steeringMode' ? 'Steering 消息处理' : 'Follow-up 消息处理', runtime[key] ?? snapshot.settings.effective[key], ['all', 'one-at-a-time'], (value) => runtimePatch({ [key]: value }))}</div>)}{(['compactionEnabled', 'retryEnabled'] as const).map((key) => <label key={key} className="flex items-center gap-3 text-sm"><input type="checkbox" checked={runtime[key] ?? snapshot.settings.effective[key]} onChange={(event) => runtimePatch({ [key]: event.target.checked })} />{key === 'compactionEnabled' ? '自动压缩上下文' : '失败后自动重试'}{runtime[key] === undefined && <span className="text-xs text-muted-foreground">（沿用默认值）</span>}</label>)}</section>
        {sessionId && <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm">项目覆盖与实际生效值（只读）</summary><p className="mt-3 text-xs text-muted-foreground">项目运行设置的编辑遵循 Pi 公开 setter 能力。</p><pre className="mt-3 overflow-auto text-xs">{JSON.stringify({ project: snapshot.settings.project, effective: snapshot.settings.effective }, null, 2)}</pre></details>}
      </>}
      {category === 'credentials' && <section className="space-y-5 rounded-xl border p-5"><label className="grid gap-2"><span className="text-sm font-medium">提供商</span><ProviderSelector value={provider} disabled={busy} providers={snapshot.providers} onValueChange={(next) => guard(() => { setProvider(next); setApiKey('') })} /></label><div className="rounded-lg bg-muted/40 p-3 text-sm"><p>存储认证：{selectedProvider?.credentialType ?? '未存储'}</p><p className="mt-1 text-xs text-muted-foreground">来源：{selectedProvider?.source ?? '由 Pi 在运行时解析环境变量或云凭据'}。删除存储凭据后，环境变量或模型配置仍可能提供认证。</p></div><label className="grid gap-2"><span className="text-sm font-medium">新的 API Key</span><input className={settingsInputClass} type="password" autoComplete="new-password" value={apiKey} disabled={!selectedProvider?.apiKeyLogin} onChange={(event) => { setApiKey(event.target.value) }} /><span className="text-xs leading-5 text-muted-foreground">已保存的密钥不会返回浏览器。OAuth、订阅和需要多项信息的认证请使用 Pi /login；自定义提供商也可在模型配置中设置 apiKey。</span></label><Button type="button" variant="destructive" disabled={!selectedProvider?.credentialType} onClick={() => setRemoveCredential(true)}>删除存储凭据</Button></section>}
      {category === 'resources' && <section className="space-y-5 rounded-xl border p-5"><p className="text-xs leading-5 text-muted-foreground">保存资源来源与加载路径；包的实际安装使用 Pi CLI。项目资源必须先被 Pi 信任。</p>{(['extensions', 'skills', 'prompts', 'themes'] as const).map((key) => <label className="grid gap-2" key={key}><span className="text-sm font-medium">{{ extensions: '扩展路径', skills: 'Skills 路径', prompts: '提示词模板路径', themes: '主题路径' }[key]}</span><Textarea value={(resources[key] ?? []).join('\n')} placeholder="每行一个路径或排除规则" onChange={(event) => { setResources({ ...resources, [key]: event.target.value.split('\n').filter((line) => line.trim()) }) }} /></label>)}<label className="grid gap-2"><span className="text-sm font-medium">Packages（JSON 数组）</span><Textarea className="min-h-32 font-mono text-xs" value={packages} onChange={(event) => { setPackages(event.target.value) }} /><span className="text-xs text-muted-foreground">支持来源字符串，以及包含 source、autoload、资源筛选列表的对象。</span></label></section>}
      {category === 'advanced' && <section className="space-y-5 rounded-xl border p-5">{selectField('模型传输方式', advanced.transport, ['auto', 'sse', 'websocket', 'websocket-cached'], (transport) => advancedPatch({ transport: transport as PiAdvancedSettings['transport'] }))}<label className="grid gap-2"><span className="text-sm font-medium">HTTP 空闲超时</span><span className="flex w-full max-w-72 items-center gap-3"><input className={settingsInputClass} inputMode="decimal" value={timeoutSeconds} aria-invalid={timeoutMs === undefined} onChange={(event) => setTimeoutSeconds(event.target.value)} /><span className="text-sm text-muted-foreground">秒</span></span><span className={`text-xs ${timeoutMs === undefined ? 'text-destructive' : 'text-muted-foreground'}`}>{timeoutMs === undefined ? '请输入 0–3600 秒，最多三位小数。' : timeoutMs > 0 && timeoutMs % 60000 === 0 ? `${timeoutMs / 60000} 分钟` : '支持毫秒精度，最多三位小数。'}</span></label>{selectField('缓存预热', advanced.cacheWarming, ['off', 'streaming', 'idle'], (cacheWarming) => advancedPatch({ cacheWarming: cacheWarming as PiAdvancedSettings['cacheWarming'] }))}<p className="text-xs text-muted-foreground">缓存预热可能产生额外模型费用。</p><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={advanced.enableSkillCommands} onChange={(event) => advancedPatch({ enableSkillCommands: event.target.checked })} />启用 Skill 命令</label><label className="grid gap-2"><span className="text-sm font-medium">模型轮换范围</span><Textarea placeholder="每行一个 Pi 模型匹配规则；清空后使用空列表" value={(advanced.enabledModels ?? []).join('\n')} onChange={(event) => advancedPatch({ enabledModels: event.target.value.split('\n').filter((line) => line.trim()) })} /></label></section>}
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center gap-3"><Button type="submit" disabled={busy || !dirty || (category === 'advanced' && timeoutMs === undefined) || (category === 'credentials' && (!apiKey.trim() || !selectedProvider?.apiKeyLogin))}>{busy ? '正在保存…' : category === 'credentials' ? '保存 API Key' : '保存配置'}</Button><span className="text-xs text-muted-foreground">{scope === 'global' ? '保存到全局' : '保存到当前项目'}</span></div>
    <AlertDialog open={removeCredential} onOpenChange={setRemoveCredential}><AlertDialogContent><AlertDialogTitle>删除 {provider} 的存储凭据？</AlertDialogTitle><AlertDialogDescription>Pi CLI 和其他会话也会受到影响。环境变量和模型配置中的认证不会删除。</AlertDialogDescription><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setRemoveCredential(false)}>取消</Button><Button variant="destructive" onClick={() => { setRemoveCredential(false); void save({ category: 'credentials', provider, apiKey: null }) }}>删除凭据</Button></div></AlertDialogContent></AlertDialog>
  </form>
}
