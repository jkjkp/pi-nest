import { selectProjectFolder } from './project-folder-picker.js'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { configurationSecurity } from './configuration-routes.js'
import type { RuntimeSecurity } from './runtime-security.js'
import type { ProjectRegistry } from './project-registry.js'

const pathSchema = z.string().trim().min(1).max(4096)
const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), cwd: pathSchema }).strict(),
  z.object({ kind: z.literal('create'), parent: pathSchema, name: z.string().min(1).max(255) }).strict(),
])

export function createProjectRoutes(projects: ProjectRegistry, security: RuntimeSecurity) {
  return new Hono().use('/', configurationSecurity(security)).use('/', bodyLimit({ maxSize: 16_384 }))
    .use('/select-folder', configurationSecurity(security)).use('/select-folder', bodyLimit({ maxSize: 16_384 }))
    .post('/select-folder', async (context) => {
      const parsed = z.object({ cwd: pathSchema.optional() }).strict().safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: '文件夹选择请求无效。' }, 400)
      try { return context.json({ cwd: await selectProjectFolder(parsed.data.cwd) }) }
      catch (cause) {
        console.error('Failed to select project folder', { cause })
        return context.json({ error: cause instanceof Error && !('code' in cause) ? cause.message : '无法打开系统文件夹选择器，请重试。' }, 503)
      }
    })
    .get('/', (context) => {
      try { return context.json({ projects: projects.list() }) }
      catch { return context.json({ error: '无法读取已添加项目，请检查项目登记文件。' }, 500) }
    })
    .post('/', async (context) => {
      const parsed = requestSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: '项目路径或文件夹名称无效。' }, 400)
      try {
        const request = parsed.data
        const project = request.kind === 'open' ? projects.open(request.cwd) : projects.create(request.parent, request.name)
        return context.json({ project }, 201)
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        const error = code === 'EEXIST' ? '该文件夹已存在，请使用“打开项目”。' : code === 'ENOENT' ? '文件夹不存在，请检查路径。' : code === 'EACCES' || code === 'EPERM' ? '没有访问或创建该文件夹的权限。' : cause instanceof Error ? cause.message : '项目操作失败。'
        return context.json({ error }, code === 'EEXIST' ? 409 : 400)
      }
    })
}
