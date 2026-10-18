import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { listPiSessions } from '@pi-nest/pi-adapter'
import type { PiSessionFilePreview } from '@pi-nest/contracts'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { configurationSecurity } from './configuration-routes.js'
import type { RuntimeSecurity } from './runtime-security.js'
import { resolveProjectDirectory } from './project-registry.js'

const maxPreviewBytes = 1_048_576
class PreviewError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 413 | 415) { super(message) }
}

function assertInside(root: string, path: string) {
  const child = relative(root, path)
  if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new PreviewError('只能预览当前会话项目内的文件。', 403)
}

export async function readSessionFilePreview(cwd: string, path: string, searchRoot?: string): Promise<PiSessionFilePreview> {
  const root = resolveProjectDirectory(cwd)
  let requested = resolve(root, path)
  if (searchRoot !== undefined) {
    const scope = resolve(root, searchRoot)
    assertInside(root, scope)
    const canonicalScope = await realpath(scope)
    assertInside(root, canonicalScope)
    const scopeInfo = await stat(canonicalScope)
    if (scopeInfo.isFile()) {
      if (path !== basename(scope)) throw new PreviewError('搜索结果与文件范围不匹配。', 400)
      requested = canonicalScope
    } else if (scopeInfo.isDirectory()) {
      requested = resolve(canonicalScope, path)
      assertInside(canonicalScope, requested)
    } else throw new PreviewError('搜索范围不是文件或目录。', 400)
  }
  assertInside(root, requested)
  const canonical = await realpath(requested)
  assertInside(root, canonical)
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new PreviewError('此路径不是普通文件。', 400)
    // Recheck containment and identity after opening; never read a replaced path's descriptor.
    const current = await realpath(canonical)
    assertInside(root, current)
    const currentInfo = await stat(current)
    if (info.dev !== currentInfo.dev || info.ino !== currentInfo.ino) throw new PreviewError('文件已变化，请重试。', 400)
    if (info.size > maxPreviewBytes) throw new PreviewError('文件超过 1 MiB，无法在此预览。', 413)
    const buffer = Buffer.alloc(maxPreviewBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxPreviewBytes) throw new PreviewError('文件超过 1 MiB，无法在此预览。', 413)
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) }
    catch { throw new PreviewError('此文件不是 UTF-8 文本，暂不支持预览。', 415) }
    if (content.includes('\0')) throw new PreviewError('二进制文件暂不支持预览。', 415)
    return { path: relative(root, canonical), content }
  } finally { await file.close() }
}

export function createSessionFilePreviewRoutes(security: RuntimeSecurity) {
  return new Hono().use('/sessions/:sessionId/file-preview', configurationSecurity(security)).use('/sessions/:sessionId/file-preview', bodyLimit({ maxSize: 16_384 }))
    .post('/sessions/:sessionId/file-preview', async (context) => {
      const parsed = z.object({ path: z.string().min(1).max(4096).refine((path) => !path.includes('\0')), searchRoot: z.string().min(1).max(4096).refine((path) => !path.includes('\0')).optional() }).strict().safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: '文件路径无效。' }, 400)
      try {
        const session = (await listPiSessions()).find((session) => session.id === context.req.param('sessionId'))
        if (!session?.cwd) return context.json({ error: '找不到项目会话。' }, 404)
        return context.json(await readSessionFilePreview(session.cwd, parsed.data.path, parsed.data.searchRoot))
      } catch (error) {
        if (error instanceof PreviewError) return context.json({ error: error.message }, error.status)
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return context.json({ error: '文件已删除或不存在。' }, 404)
        if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') return context.json({ error: '无法访问此文件。' }, 403)
        return context.json({ error: '读取文件失败，请重试。' }, 500)
      }
    })
}
