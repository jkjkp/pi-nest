import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, rename, unlink, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAgentDir, getPackageDir, ModelRuntime, ProjectTrustStore, SettingsManager } from '@earendil-works/pi-coding-agent'
import type { PiConfigDocument, PiConfigurationSnapshot, PiConfigurationUpdate, PiMcpDiagnostics, PiResourceSettings } from '@pi-nest/contracts'
import { readPiSettings, updatePiSettings } from './settings.js'

export const piSecretPlaceholder = '••••（保留已配置值）'
export class PiConfigurationConflict extends Error {}
export class PiConfigurationInvalid extends Error {}
type ObjectValue = Record<string, unknown>
const isObject = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const revision = (text: string) => createHash('sha256').update(text).digest('hex')

async function readDocument(path: string) {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = ''
  }
  const data: unknown = text ? JSON.parse(text) : {}
  if (!isObject(data)) throw new PiConfigurationInvalid('配置文件必须是 JSON 对象')
  return { text, data, revision: revision(text) }
}

// Redact containers too: arbitrary environment and header names may contain credentials.
export function redactPiConfiguration(value: unknown, secret = false): unknown {
  if (typeof value === 'string') {
    if (secret && value) return piSecretPlaceholder
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value)
      if (url.username || url.password || url.search) return piSecretPlaceholder
    }
    return value
  }
  if (Array.isArray(value)) return value.map((item) => redactPiConfiguration(item, secret))
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPiConfiguration(item, secret || /apiKey|secret|password|token|authorization|headers|env|args/i.test(key))]))
}

export function restorePiSecrets(value: unknown, previous: unknown): unknown {
  if (value === piSecretPlaceholder) {
    if (previous === undefined) throw new PiConfigurationInvalid('新条目不能使用密钥保留标记')
    return previous
  }
  if (Array.isArray(value)) return value.map((item, index) => restorePiSecrets(item, Array.isArray(previous) ? previous[index] : undefined))
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new PiConfigurationInvalid('不支持的配置键')
    return [key, restorePiSecrets(item, isObject(previous) ? previous[key] : undefined)]
  }))
}

function entries(data: ObjectValue, key: string): Record<string, ObjectValue> {
  const result = data[key] ?? {}
  if (!isObject(result) || Object.values(result).some((entry) => !isObject(entry))) throw new PiConfigurationInvalid('配置条目格式错误')
  return result as Record<string, ObjectValue>
}

async function configDocument(path: string, key: string): Promise<PiConfigDocument> {
  const current = await readDocument(path)
  return { revision: current.revision, entries: redactPiConfiguration(entries(current.data, key)) as Record<string, ObjectValue>, ...(typeof current.data.autoEnableCodemode === 'boolean' ? { autoEnableCodemode: current.data.autoEnableCodemode } : {}) }
}

function resources(settings: ReturnType<SettingsManager['getSettings']>): Partial<PiResourceSettings> {
  return { packages: settings.packages, extensions: settings.extensions, skills: settings.skills, prompts: settings.prompts, themes: settings.themes }
}

export async function readPiConfiguration(cwd: string): Promise<PiConfigurationSnapshot> {
  const agentDir = getAgentDir()
  const projectTrusted = new ProjectTrustStore(agentDir).get(cwd) === true
  const manager = SettingsManager.create(cwd, agentDir, { projectTrusted })
  if (manager.drainErrors().length) throw new Error('无法读取 Pi 设置')
  const globalManager = SettingsManager.inMemory(manager.getGlobalSettings())
  // Reading settings must not run credential commands, refresh OAuth, or connect to providers.
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false })
  const credentials = await runtime.listCredentials()
  const stored = new Map(credentials.map((credential) => [credential.providerId, credential.type]))
  const providers = runtime.getProviders().map((provider) => {
    const status = runtime.getProviderAuthStatus(provider.id)
    return { id: provider.id, name: provider.name, credentialType: stored.get(provider.id), source: stored.has(provider.id) ? 'stored' : status.source, apiKeyLogin: Boolean(provider.auth?.apiKey?.login) }
  })
  for (const credential of credentials) {
    if (!providers.some((provider) => provider.id === credential.providerId)) providers.push({ id: credential.providerId, name: credential.providerId, credentialType: credential.type, source: 'stored', apiKeyLogin: false })
  }
  const errors: NonNullable<PiConfigurationSnapshot['errors']> = {}
  async function documentOrError(path: string, key: string, category: keyof typeof errors) {
    try { return await configDocument(path, key) } catch {
      errors[category] = '该分类的原生配置文件无法解析，请先在本地修正 JSON 格式，再重新加载。'
      return { revision: '', entries: {} }
    }
  }
  if (runtime.getError()) errors['custom-models'] = 'Pi 未能加载部分模型配置，请检查并修正条目。'
  const customModels = await documentOrError(join(agentDir, 'models.json'), 'providers', 'custom-models')
  const mcp = await documentOrError(join(agentDir, 'mcp.json'), 'mcpServers', 'mcp')
  const projectMcp = projectTrusted ? await documentOrError(join(cwd, '.pi/mcp.json'), 'mcpServers', 'project-mcp') : undefined
  return {
    errors,
    settings: readPiSettings(cwd),
    resources: { packages: [], extensions: [], skills: [], prompts: [], themes: [], ...Object.fromEntries(Object.entries(resources(manager.getGlobalSettings())).filter(([, value]) => value !== undefined)) } as PiResourceSettings,
    projectResources: projectTrusted ? resources(manager.getProjectSettings()) : undefined,
    advanced: { transport: globalManager.getTransport(), httpIdleTimeoutMs: globalManager.getHttpIdleTimeoutMs(), cacheWarming: globalManager.getCacheWarmingMode(), enableSkillCommands: globalManager.getEnableSkillCommands(), enabledModels: globalManager.getEnabledModels() },
    customModels, mcp, projectMcp,
    projectTrusted, providers,
    models: runtime.getModels().map((model) => ({ id: model.id, provider: model.provider, name: model.name, thinkingLevels: model.reasoning ? ['off', ...Object.keys(model.thinkingLevelMap ?? { minimal: '', low: '', medium: '', high: '' }).filter((level) => level !== 'off' && model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap] !== null)] : ['off'] })),
  }
}

export async function updatePiConfigDocument(path: string, key: string, update: { revision: string; name: string; value: ObjectValue | null }, validate?: (path: string) => Promise<void>) {
  const current = await readDocument(path)
  if (current.revision !== update.revision) throw new PiConfigurationConflict('配置已被修改，请重新加载后再保存')
  const collection = { ...entries(current.data, key) }
  if (key === 'mcpServers' && update.value !== null && Object.keys(collection).some((name) => name !== update.name && name.replaceAll('-', '_') === update.name.replaceAll('-', '_'))) throw new PiConfigurationInvalid('MCP 服务名称与已有条目冲突（连字符与下划线视为相同）')
  if (update.value === null) delete collection[update.name]
  else collection[update.name] = restorePiSecrets(update.value, collection[update.name]) as ObjectValue
  const next = { ...current.data, [key]: collection }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  // shortcut: a process crash can leave this lock directory; remove it after verifying no writer is running.
  const lock = `${path}.lock`
  try { await mkdir(lock) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PiConfigurationConflict('配置正在被其他进程修改，请稍后重试')
    throw error
  }
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await validate?.(temporary)
    if ((await readDocument(path)).revision !== current.revision) throw new PiConfigurationConflict('配置已被修改，请重新加载后再保存')
    // shortcut: external editors may ignore the lock; revision checks catch changes before rename, not simultaneous writes.
    await rename(temporary, path)
  } finally {
    try { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
    finally { await rmdir(lock) }
  }
}

export async function updatePiConfiguration(cwd: string, update: PiConfigurationUpdate) {
  const agentDir = getAgentDir()
  const projectTrusted = new ProjectTrustStore(agentDir).get(cwd) === true
  if ('scope' in update && update.scope === 'project' && !projectTrusted) throw new PiConfigurationInvalid('请先在 Pi 中信任该项目')
  if (update.category === 'models') {
    const current = readPiSettings(cwd).effective
    const provider = update.values.defaultProvider ?? current.defaultProvider
    const modelId = update.values.defaultModel ?? current.defaultModel
    if (update.values.defaultProvider !== undefined || update.values.defaultModel !== undefined || update.values.defaultThinkingLevel !== undefined) {
      const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false })
      const model = provider && modelId ? runtime.getModel(provider, modelId) : undefined
      if ((update.values.defaultProvider !== undefined || update.values.defaultModel !== undefined) && !model) throw new PiConfigurationInvalid('模型不在 Pi 目录中，扩展提供的模型请在 Pi CLI 中设置')
      const thinking = update.values.defaultThinkingLevel
      if (model && thinking && thinking !== 'off' && (!model.reasoning || model.thinkingLevelMap && model.thinkingLevelMap[thinking as keyof typeof model.thinkingLevelMap] === null)) throw new PiConfigurationInvalid('该模型不支持所选 Thinking 级别')
    }
    await updatePiSettings(cwd, update.values)
    return
  }
  if (update.category === 'credentials') {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false })
    if (update.apiKey === null) await runtime.logout(update.provider)
    else {
      let prompted = false
      await runtime.login(update.provider, 'api_key', {
        signal: AbortSignal.timeout(15_000),
        notify: () => undefined,
        prompt: async (prompt) => {
          if (prompt.type !== 'secret' || prompted) throw new PiConfigurationInvalid('该提供商需要额外认证信息，请使用 Pi /login')
          prompted = true
          return update.apiKey!
        },
      })
    }
    return
  }
  if (update.category === 'custom-models' || update.category === 'mcp') {
    const models = update.category === 'custom-models'
    if (models && update.scope !== 'global') throw new PiConfigurationInvalid('自定义模型仅支持全局配置')
    const path = join(update.scope === 'global' ? agentDir : join(cwd, '.pi'), models ? 'models.json' : 'mcp.json')
    await updatePiConfigDocument(path, models ? 'providers' : 'mcpServers', update, models ? async (modelsPath) => {
      const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false, allowModelNetwork: false })
      if (runtime.getError()) throw new PiConfigurationInvalid('模型配置未通过 Pi 原生校验，请检查协议、模型和兼容参数')
    } : undefined)
    return
  }
  const manager = SettingsManager.create(cwd, agentDir, { projectTrusted })
  if (manager.drainErrors().length) throw new Error('无法读取 Pi 设置')
  if (update.category === 'resources') {
    const setters = update.scope === 'project'
      ? { packages: manager.setProjectPackages.bind(manager), extensions: manager.setProjectExtensionPaths.bind(manager), skills: manager.setProjectSkillPaths.bind(manager), prompts: manager.setProjectPromptTemplatePaths.bind(manager), themes: manager.setProjectThemePaths.bind(manager) }
      : { packages: manager.setPackages.bind(manager), extensions: manager.setExtensionPaths.bind(manager), skills: manager.setSkillPaths.bind(manager), prompts: manager.setPromptTemplatePaths.bind(manager), themes: manager.setThemePaths.bind(manager) }
    const values = update.values
    if (values.packages !== undefined) setters.packages(values.packages)
    for (const key of ['extensions', 'skills', 'prompts', 'themes'] as const) if (values[key] !== undefined) setters[key](values[key])
  } else if (update.category === 'advanced') {
    const values = update.values
    if (values.transport !== undefined) manager.setTransport(values.transport)
    if (values.httpIdleTimeoutMs !== undefined) manager.setHttpIdleTimeoutMs(values.httpIdleTimeoutMs)
    if (values.cacheWarming !== undefined) manager.setCacheWarmingMode(values.cacheWarming)
    if (values.enableSkillCommands !== undefined) manager.setEnableSkillCommands(values.enableSkillCommands)
    if (values.enabledModels !== undefined) manager.setEnabledModels(values.enabledModels)
  }
  await manager.flush()
  if (manager.drainErrors().length) throw new Error('Pi 设置保存失败')
}

export async function diagnosePiMcp(cwd: string): Promise<PiMcpDiagnostics> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(getPackageDir(), 'dist/bundle/cli.js'), 'mcp', 'list', '--json'], {
      cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PI_CODING_AGENT_DIR: getAgentDir() },
    })
    let output = ''
    let tooLarge = false
    let timedOut = false
    function signalGroup(signal: NodeJS.Signals) {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    const timer = setTimeout(() => {
      timedOut = true
      signalGroup('SIGTERM')
      setTimeout(() => signalGroup('SIGKILL'), 1000).unref()
    }, 45_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (output.length + chunk.length > 1_000_000) { tooLarge = true; signalGroup('SIGKILL') }
      else output += chunk
    })
    child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动 MCP 诊断')) })
    child.once('close', (code) => {
      clearTimeout(timer)
      // Kill the diagnostic process group as well as the CLI, including abandoned stdio children.
      signalGroup('SIGTERM')
      try {
        if (timedOut || tooLarge) throw new Error()
        const data = JSON.parse(output) as { servers: { name: string; state: string; tools: string[] }[]; errors: unknown[] }
        resolve({ hasErrors: code !== 0 || data.errors.length > 0, servers: data.servers.map(({ name, state, tools }) => ({ name, state, tools })) })
      } catch { reject(new Error('MCP 诊断失败或超时，请使用 pi mcp list 查看详情')) }
    })
  })
}
