import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { homedir } from 'node:os'
import { discoverPiModels, diagnosePiMcp, listPiSessions, PiConfigurationConflict, PiConfigurationInvalid, readPiConfiguration, updatePiConfiguration } from '@pi-nest/pi-adapter'
import type { PiRuntimeRegistry } from './pi-runtime-registry.js'
import type { RuntimeSecurity } from './runtime-security.js'
import { configurationUpdateSchema } from './configuration-schema.js'
import { ProjectRegistry } from './project-registry.js'

export function configurationSecurity(security: RuntimeSecurity): MiddlewareHandler {
  return async (context, next) => {
    context.header('Cache-Control', 'no-store')
    const origin = context.req.header('origin')
    if ((origin && !security.acceptsOrigin(origin)) || (!['GET', 'HEAD'].includes(context.req.method) && !security.acceptsOrigin(origin)) || !security.acceptsToken(context.req.header('x-pi-nest-token'))) return context.json({ error: '设置访问被拒绝' }, 403)
    await next()
  }
}

export function createConfigurationRoutes(runtime: PiRuntimeRegistry, security: RuntimeSecurity, projects = new ProjectRegistry()) {
  const routes = new Hono().use('*', configurationSecurity(security))
  routes.use('*', bodyLimit({ maxSize: 1_000_000 }))
  async function cwdFor(sessionId?: string) {
    if (!sessionId) return homedir()
    const session = (await listPiSessions()).find((candidate) => candidate.id === sessionId)
    return session?.cwd
  }
  return routes
    .get('/', async (context) => {
      try {
        const project = context.req.query('project')
        if (project && context.req.query('session')) return context.json({ error: '请选择项目或会话之一' }, 400)
        if (project && !(await listPiSessions()).some((session) => session.cwd === project) && !projects.has(project)) return context.json({ error: '找不到项目' }, 404)
        const cwd = project || await cwdFor(context.req.query('session'))
        if (!cwd) return context.json({ error: '找不到项目会话' }, 404)
        return context.json(await readPiConfiguration(cwd))
      } catch { return context.json({ error: '无法读取 Pi 配置，请检查原生配置文件格式' }, 500) }
    })
    .patch('/', async (context) => {
      const parsed = configurationUpdateSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: '配置格式不正确，请检查必填字段、传输方式和参数类型' }, 400)
      const update = parsed.data
      if ('scope' in update && update.scope === 'project' && !context.req.query('session')) return context.json({ error: '项目配置需要选择会话' }, 400)
      let cwd: string | undefined
      try { cwd = await cwdFor(context.req.query('session')) } catch { return context.json({ error: '无法解析项目' }, 500) }
      if (!cwd) return context.json({ error: '找不到项目会话' }, 404)
      const finish = runtime.beginGlobalSettingsUpdate()
      if (!finish) return context.json({ error: 'Pi 正在运行，请等待任务结束后保存' }, 409)
      try {
        await updatePiConfiguration(cwd, update)
        return context.json({ saved: true })
      } catch (error) {
        if (error instanceof PiConfigurationConflict) return context.json({ error: error.message }, 409)
        if (error instanceof PiConfigurationInvalid) return context.json({ error: error.message }, 400)
        return context.json({ error: '保存失败，请重新加载确认配置状态' }, 500)
      } finally {
        // A native setter can commit before a later operation fails; reload idle hosts either way.
        await finish(true)
      }
    })
    .post('/models/discover', async (context) => {
      const parsed = z.object({
        provider: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name)),
        connection: z.object({ baseUrl: z.string().min(1).max(4096), api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']), apiKey: z.string().max(16384).optional(), headers: z.record(z.string().max(256), z.string().max(16384)).optional() }).strict(),
      }).strict().safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: '请填写提供商 ID、Base URL 和支持的 API 协议。' }, 400)
      try { return context.json({ models: await discoverPiModels(parsed.data) }) }
      catch (error) { return context.json({ error: error instanceof PiConfigurationInvalid ? error.message : '获取模型列表失败或超时，请检查连接或手动添加。' }, 400) }
    })
    .post('/mcp/test', async (context) => {
      let cwd: string | undefined
      try { cwd = await cwdFor(context.req.query('session')) } catch { return context.json({ error: '无法解析项目' }, 500) }
      if (!cwd) return context.json({ error: '找不到项目会话' }, 404)
      const finish = runtime.beginGlobalSettingsUpdate()
      if (!finish) return context.json({ error: '请等待 Pi 任务结束后测试连接' }, 409)
      try { return context.json(await diagnosePiMcp(cwd)) }
      catch { return context.json({ error: '连接测试失败或超时，请使用 pi mcp list 查看详情' }, 500) }
      finally { await finish(false) }
    })
}
