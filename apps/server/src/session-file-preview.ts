import { openPreviewFile, PreviewError } from './preview-file.js'
import { readTextFilePage, readTextFileStat, textPageRequestFields } from './text-file-pages.js'
import imageSize from 'buffer-image-size'
import type { PiSessionFilePreview } from '@pi-nest/contracts'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { configurationSecurity } from './configuration-routes.js'
import type { RuntimeSecurity } from './runtime-security.js'
import type { SessionIndex } from './session-index.js'

const maxPreviewBytes = 1_048_576

async function readPreviewFile(cwd: string, path: string, searchRoot: string | undefined, maxBytes: number, allowedRoot?: string) {
  const opened = await openPreviewFile(cwd, path, searchRoot, allowedRoot)
  const { file, info } = opened
  try {
    if (info.size > maxBytes) throw new PreviewError(`文件超过 ${maxBytes / 1_048_576} MiB，无法在此预览。`, 413)
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxBytes) throw new PreviewError(`文件超过 ${maxBytes / 1_048_576} MiB，无法在此预览。`, 413)
    return { path: opened.path, buffer: buffer.subarray(0, length) }
  } finally { await file.close() }
}

export async function readSessionFilePreview(cwd: string, path: string, searchRoot?: string, allowedRoot?: string): Promise<PiSessionFilePreview> {
  const file = await readPreviewFile(cwd, path, searchRoot, maxPreviewBytes, allowedRoot)
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer) }
  catch { throw new PreviewError('此文件不是 UTF-8 文本，暂不支持预览。', 415) }
  if (content.includes('\0')) throw new PreviewError('二进制文件暂不支持预览。', 415)
  return { path: file.path, content }
}

export async function readSessionImagePreview(cwd: string, path: string, searchRoot?: string, allowedRoot?: string) {
  const file = await readPreviewFile(cwd, path, searchRoot, 10 * maxPreviewBytes, allowedRoot)
  const bytes = file.buffer
  const raster = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || bytes.subarray(0, 2).equals(Buffer.from('ffd8', 'hex'))
    || ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
    || (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
  if (!raster) throw new PreviewError('仅支持 PNG、JPEG、WebP 和 GIF 图片。', 415)
  let dimensions: ReturnType<typeof imageSize>
  try { dimensions = imageSize(file.buffer) }
  catch { throw new PreviewError('图片格式无效或文件已损坏。', 415) }
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[dimensions.type]
  if (!mime) throw new PreviewError('仅支持 PNG、JPEG、WebP 和 GIF 图片。', 415)
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > 40_000_000) throw new PreviewError('图片超过 4000 万像素，无法在此预览。', 413)
  return { ...file, mime }
}

export function createSessionFilePreviewRoutes(security: RuntimeSecurity, sessions: SessionIndex) {
  const routes = new Hono()
  for (const endpoint of ['/sessions/:sessionId/file-preview', '/sessions/:sessionId/file-preview/image', '/sessions/:sessionId/file-preview/text-page', '/sessions/:sessionId/file-preview/stat']) {
    routes.use(endpoint, configurationSecurity(security), bodyLimit({ maxSize: 16_384 }))
    routes.post(endpoint, async (context) => {
      const schema = z.object({ path: z.string().min(1).max(4096).refine((path) => !path.includes('\0')), searchRoot: z.string().min(1).max(4096).refine((path) => !path.includes('\0')).optional() }).strict()
      const parsed = (endpoint.endsWith('/text-page') ? schema.extend(textPageRequestFields) : schema).safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: '文件路径无效。' }, 400)
      try {
        const sessionId = context.req.param('sessionId')
        if (!sessionId) return context.json({ error: '找不到项目会话。' }, 404)
        const session = await sessions.resolve(sessionId)
        if (!session || !session.cwd) return context.json({ error: '找不到项目会话。' }, 404)
        const input = { cwd: session.cwd, ...parsed.data, signal: context.req.raw.signal }
        if (endpoint.endsWith('/text-page')) return context.json(await readTextFilePage(input))
        if (endpoint.endsWith('/stat')) return context.json(await readTextFileStat(input))
        if (endpoint.endsWith('/image')) {
          const image = await readSessionImagePreview(session.cwd, parsed.data.path, parsed.data.searchRoot)
          context.header('Content-Type', image.mime)
          context.header('X-Content-Type-Options', 'nosniff')
          context.header('X-Pi-Nest-File-Path', encodeURIComponent(image.path))
          return context.body(new Uint8Array(image.buffer))
        }
        return context.json(await readSessionFilePreview(session.cwd, parsed.data.path, parsed.data.searchRoot))
      } catch (error) {
        if (error instanceof PreviewError) return context.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status)
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return context.json({ error: '文件已删除或不存在。' }, 404)
        if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') return context.json({ error: '无法访问此文件。' }, 403)
        return context.json({ error: '读取文件失败，请重试。' }, 500)
      }
    })
  }
  return routes
}
