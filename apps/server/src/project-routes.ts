import { isAbsolute } from 'node:path'
import { ProjectStorageError } from './project-registry.js'
import type { SessionIndex } from './session-index.js'
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

export function createProjectRoutes(projects: ProjectRegistry, security: RuntimeSecurity, sessions?: SessionIndex) {
  return new Hono().use('*', configurationSecurity(security)).use('*', bodyLimit({ maxSize: 65_536 }))
    .onError((error, context) => {
      console.error('Project operation failed', { cause: error })
      return context.json({ error: error instanceof ProjectStorageError ? error.message : '项目数据库或会话索引不可用，请检查后重试。', code: 'PROJECT_STORAGE_UNAVAILABLE' }, 503)
    })
    .get('/migration', (context) => context.json({ pending: projects.legacyVisibilityPending }))
    .post('/migration', async (context) => {
      const parsed = z.object({ paths: z.array(pathSchema.refine(isAbsolute)).max(1000) }).strict().safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: '旧项目可见性迁移请求无效。' }, 400)
      projects.migrateVisibility(parsed.data.paths)
      return context.body(null, 204)
    })
    .delete('/:id', (context) => projects.remove(context.req.param('id')) ? context.body(null, 204) : context.json({ error: '项目不存在。' }, 404))
    .post('/:id/restore', (context) => projects.restore(context.req.param('id')) ? context.body(null, 204) : context.json({ error: '项目不存在。' }, 404))
    .post('/select-folder', async (context) => {
      const parsed = z.object({ cwd: pathSchema.optional() }).strict().safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: '文件夹选择请求无效。' }, 400)
      try { return context.json({ cwd: await selectProjectFolder(parsed.data.cwd, context.req.raw.signal) }) }
      catch (cause) {
        console.error('Failed to select project folder', { cause })
        const code = (cause as { code?: string }).code
        const pickerError = code === 'PROJECT_FOLDER_PICKER_BUSY' || code === 'PROJECT_FOLDER_PICKER_TIMEOUT'
        return context.json({ error: cause instanceof Error && (pickerError || !code) ? cause.message : '无法打开系统文件夹选择器，请重试或手动输入绝对路径。', code: pickerError ? code : 'PROJECT_FOLDER_PICKER_FAILED' }, 503)
      }
    })
    .get('/', async (context) => {
      const state = context.req.query('state') ?? 'active'
      if (state !== 'active' && state !== 'removed') return context.json({ error: '项目状态无效。' }, 400)
      if (sessions) projects.sync(await sessions.list())
      context.header('Cache-Control', 'no-store')
      return context.json({ projects: projects.list(state) })
    })
    .post('/', async (context) => {
      const parsed = requestSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: '项目路径或文件夹名称无效。' }, 400)
      try {
        const request = parsed.data
        const project = request.kind === 'open' ? projects.open(request.cwd) : projects.create(request.parent, request.name)
        return context.json({ project }, 201)
      } catch (cause) {
        if (cause instanceof ProjectStorageError) throw cause
        const code = (cause as NodeJS.ErrnoException).code
        if (code?.startsWith('SQLITE_')) throw cause
        const error = code === 'EEXIST' ? '该文件夹已存在，请使用“打开项目”。' : code === 'ENOENT' ? '文件夹不存在，请检查路径。' : code === 'EACCES' || code === 'EPERM' ? '没有访问或创建该文件夹的权限。' : cause instanceof Error ? cause.message : '项目操作失败。'
        return context.json({ error }, code === 'EEXIST' ? 409 : 400)
      }
    })
}
