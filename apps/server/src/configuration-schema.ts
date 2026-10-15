import { z } from 'zod'

const text = z.string().min(1).max(4096)
const strings = z.array(text).max(512)
const scope = z.enum(['global', 'project'])
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value))
const map = z.record(z.string().max(256), z.string().max(16384))
const exposure = z.enum(['codemode', 'deferred', 'direct', 'hidden'])
const url = z.string().max(4096).refine((value) => {
  if (value === '••••（保留已配置值）') return true
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
})
const oauth = z.object({
  clientId: text.optional(), clientSecret: text.optional(), callbackPort: z.number().int().min(1).max(65535).optional(),
  callbackUrl: url.refine((value) => { try { const parsed = new URL(value); return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) } catch { return false } }).optional(),
  scope: text.optional(), clientName: text.optional(), clientRegistration: z.enum(['dcr', 'cimd']).optional(), authServerMetadataUrl: url.optional(),
}).strict()
export const mcpValueSchema = z.object({
  type: z.enum(['stdio', 'http', 'streamable-http']).optional(), command: text.optional(), args: z.array(z.string().max(16384)).max(512).optional(),
  env: map.optional(), cwd: text.optional(), url: url.optional(), headers: map.optional(), oauth: oauth.optional(),
  auth: z.object({ provider: text }).strict().optional(),
  enabled: z.boolean().optional(), exposure: exposure.optional(), toolExposure: z.record(z.string().max(256), exposure).optional(),
  timeout: z.number().positive().max(3600).optional(), description: z.string().max(4096).optional(),
}).strict().superRefine((value, context) => {
  if (value.command && value.url) context.addIssue({ code: 'custom', message: '只能选择一种传输方式' })
  if (value.type === 'stdio' && !value.command || (value.type === 'http' || value.type === 'streamable-http') && !value.url) context.addIssue({ code: 'custom', message: '传输方式不匹配' })
  if (!value.command && !value.url && Object.keys(value).some((key) => !['enabled', 'exposure', 'toolExposure'].includes(key))) context.addIssue({ code: 'custom', message: '缺少 command 或 url' })
  if (value.command && (value.headers || value.oauth || value.auth) || value.url && (value.args || value.env || value.cwd)) context.addIssue({ code: 'custom', message: '传输参数不匹配' })
})
const model = z.object({
  id: text, name: text.optional(), api: text.optional(), baseUrl: url.optional(), reasoning: z.boolean().optional(),
  contextWindow: z.number().positive().optional(), maxTokens: z.number().positive().optional(), input: z.array(z.enum(['text', 'image'])).optional(), headers: map.optional(),
}).passthrough()
const provider = z.object({ baseUrl: url.optional(), api: text.optional(), apiKey: z.string().max(16384).optional(), headers: map.optional(), authHeader: z.boolean().optional(), models: z.array(model).max(512).optional(), modelOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).passthrough()
export const runtimeSettingsSchema = z.object({
  compactionEnabled: z.boolean().optional(), defaultModel: z.string().min(1).max(256).optional(), defaultProvider: z.string().min(1).max(256).optional(),
  defaultThinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  followUpMode: z.enum(['all', 'one-at-a-time']).optional(), retryEnabled: z.boolean().optional(), steeringMode: z.enum(['all', 'one-at-a-time']).optional(),
}).strict()
const packageSource = z.union([text, z.object({ source: text, autoload: z.boolean().optional(), extensions: strings.optional(), skills: strings.optional(), prompts: strings.optional(), themes: strings.optional() }).strict()])
export const configurationUpdateSchema = z.discriminatedUnion('category', [
  z.object({ category: z.literal('models'), values: runtimeSettingsSchema }).strict(),
  z.object({ category: z.literal('advanced'), values: z.object({ transport: z.enum(['auto', 'sse', 'websocket', 'websocket-cached']).optional(), httpIdleTimeoutMs: z.number().int().min(0).max(3600000).optional(), cacheWarming: z.enum(['off', 'streaming', 'idle']).optional(), enableSkillCommands: z.boolean().optional(), enabledModels: strings.optional() }).strict() }).strict(),
  z.object({ category: z.literal('resources'), scope, values: z.object({ packages: z.array(packageSource).max(512).optional(), extensions: strings.optional(), skills: strings.optional(), prompts: strings.optional(), themes: strings.optional() }).strict() }).strict(),
  z.object({ category: z.literal('credentials'), provider: name, apiKey: z.string().trim().min(1).max(16384).nullable() }).strict(),
  z.object({ category: z.literal('custom-models'), scope: z.literal('global'), name, revision: z.string().regex(/^[a-f0-9]{64}$/), value: provider.nullable() }).strict(),
  z.object({ category: z.literal('mcp'), scope, name, revision: z.string().regex(/^[a-f0-9]{64}$/), value: mcpValueSchema.nullable() }).strict(),
]).superRefine((update, context) => {
  if (update.category === 'mcp' && update.scope === 'global' && update.value && !update.value.command && !update.value.url) context.addIssue({ code: 'custom', message: '全局服务必须有 command 或 url' })
  if (update.category === 'mcp' && update.scope === 'project' && update.value?.auth) context.addIssue({ code: 'custom', message: '项目不能使用 provider 凭据' })
  if ('values' in update && Object.keys(update.values).length === 0) context.addIssue({ code: 'custom', message: '没有修改项' })
})
