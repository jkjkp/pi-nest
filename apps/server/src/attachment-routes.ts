import { bodyLimit } from 'hono/body-limit'
import { Hono } from 'hono'
import { z } from 'zod'
import { listPiSessions } from '@pi-nest/pi-adapter'
import type { RuntimeSecurity } from './runtime-security.js'
import type { ProjectRegistry } from './project-registry.js'
import { configurationSecurity } from './configuration-routes.js'
import { AttachmentError, type AttachmentStore } from './attachment-store.js'

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('draft'), draftId: z.string().uuid(), cwd: z.string().min(1).max(4096) }).strict(),
])
export function createAttachmentRoutes(store: AttachmentStore, security: RuntimeSecurity, projects: ProjectRegistry) {
  const routes = new Hono().use('*', configurationSecurity(security))
  routes.use('/:id/content', bodyLimit({ maxSize: 16_384 }))
  routes.use('/inspect', bodyLimit({ maxSize: 16_384 }))
  routes.onError((error, c) => {
    if (!(error instanceof AttachmentError) || error.cause) console.error('Attachment processing failed', { method: c.req.method, path: c.req.path, cause: error })
    if (error instanceof AttachmentError) return c.json({ error: error.message, code: error.code }, error.status)
    const storageFailure = ['EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'EBADF', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')
    return c.json(storageFailure
      ? { error: '附件保存或读取失败，请检查磁盘空间及目录权限后重试。', code: 'ATTACHMENT_STORAGE_FAILED' }
      : { error: '附件处理失败，请重试。', code: 'ATTACHMENT_INTERNAL' }, 500)
  })
  async function scopeFor(raw: unknown) {
    const parsed = scopeSchema.safeParse(raw)
    if (!parsed.success) throw new AttachmentError('附件范围无效。')
    const scope = parsed.data
    if (scope.kind === 'draft') {
      if (!projects.has(scope.cwd) && !(await listPiSessions()).some((s) => s.cwd === scope.cwd)) throw new AttachmentError('项目未登记。', 403)
      return `draft:${scope.draftId}:${scope.cwd}`
    }
    if (!(await listPiSessions()).some((s) => s.id === scope.sessionId)) throw new AttachmentError('会话不存在。', 404)
    return scope.sessionId
  }
  routes.post('/', async (c) => {
    if (c.req.header('content-type')?.split(';')[0] !== 'application/octet-stream') throw new AttachmentError('附件上传需要二进制请求。', 415)
    let scope: unknown
    try { scope = JSON.parse(decodeURIComponent(c.req.header('x-pi-nest-attachment-scope') ?? '')) } catch { throw new AttachmentError('附件范围无效。') }
    const owner = await scopeFor(scope)
    const encodedName = c.req.header('x-pi-nest-file-name') ?? ''
    let name: string
    try { name = decodeURIComponent(encodedName) } catch { throw new AttachmentError('文件名无效。') }
    if (name.length > 1024) throw new AttachmentError('文件名过长。')
    const attachment = await store.upload(c.req.raw.body, owner, name, c.req.header('x-pi-nest-file-type') ?? 'application/octet-stream', c.req.raw.signal)
    return c.json({ attachment }, 201)
  })
  routes.post('/:id/content', async (c) => {
    const scope = await scopeFor(await c.req.json().catch(() => undefined))
    const { ref, bytes } = store.read(c.req.param('id'), scope)
    const thumbnail = c.req.query('thumbnail') === '1' ? await store.thumbnail(ref.id, scope) : undefined
    c.header('Content-Type', thumbnail?.mimeType ?? (ref.kind === 'image' ? ref.mediaType : 'application/octet-stream'))
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cache-Control', 'private, no-store')
    c.header('Content-Disposition', `${ref.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(ref.name)}`)
    return c.body(new Uint8Array(thumbnail ? Buffer.from(thumbnail.data, 'base64') : bytes))
  })
  routes.post('/inspect', async (c) => {
    const value = await c.req.json().catch(() => undefined)
    const parsed = z.object({ scope: scopeSchema, ids: z.array(z.string()).max(8) }).strict().safeParse(value)
    if (!parsed.success) throw new AttachmentError('附件查询无效。')
    const scope = await scopeFor(parsed.data.scope)
    return c.json({ attachments: parsed.data.ids.map((id) => store.read(id, scope).ref) })
  })
  return routes
}
