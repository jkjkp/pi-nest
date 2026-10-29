import { readTextFilePage, readTextFileStat, textPageRequestFields } from './text-file-pages.js'
import { watch, type FSWatcher } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import type { WorkspaceDirectory, WorkspaceFileScope } from '@pi-nest/contracts'
import { configurationSecurity } from './configuration-routes.js'
import { PreviewError } from './preview-file.js'
import { readSessionFilePreview, readSessionImagePreview } from './session-file-preview.js'
import { isWorkspacePath } from './workspace-file-path.js'
import type { ProjectRegistry } from './project-registry.js'
import type { RuntimeSecurity } from './runtime-security.js'
import type { SessionIndex } from './session-index.js'

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), id: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('project'), cwd: z.string().min(1).max(4096) }).strict(),
])
const pathSchema = z.string().max(4096).refine(value => !value.includes('\0'))
const inputSchema = z.object({ scope: scopeSchema, path: pathSchema.default(''), offset: z.number().int().min(0).max(1_000_000).optional() }).strict()
const watchSchema = z.object({ scope: scopeSchema, paths: z.array(pathSchema).min(1).max(64) }).strict()

async function targetWithin(root: string, path: string) {
  if (isAbsolute(path)) throw new PreviewError('请使用项目内相对路径。', 403)
  const target = await realpath(resolve(root, path))
  if (!isWorkspacePath(root, target)) throw new PreviewError('文件位于项目范围之外。', 403)
  return target
}

export function createWorkspaceFileRoutes(security: RuntimeSecurity, projects: ProjectRegistry, sessions: SessionIndex) {
  async function rootFor(scope: WorkspaceFileScope) {
    const cwd = scope.kind === 'session' ? (await sessions.resolve(scope.id))?.cwd : scope.cwd
    if (!cwd) throw new PreviewError('找不到已授权项目。', 404)
    const root = await realpath(cwd)
    if (scope.kind === 'project' && !projects.has(root) && !await sessions.hasWorkspace(cwd)) throw new PreviewError('找不到已授权项目。', 404)
    if (!(await stat(root)).isDirectory()) throw new PreviewError('项目目录不存在。', 404)
    return root
  }
  const routes = new Hono().use('*', configurationSecurity(security), bodyLimit({ maxSize: 32_768 }))
  routes.onError((error, context) => {
    if (error instanceof PreviewError) return context.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return context.json({ error: '文件或目录不存在。' }, 404)
    if (['EACCES', 'EPERM', 'ELOOP'].includes(code ?? '')) return context.json({ error: '没有访问此路径的权限。' }, 403)
    return context.json({ error: '项目文件读取失败，请重试。' }, 500)
  })
  for (const endpoint of ['/list', '/preview', '/image']) routes.post(endpoint, async context => {
    const parsed = inputSchema.safeParse(await context.req.json().catch(() => undefined))
    if (!parsed.success) return context.json({ error: '项目文件请求无效。' }, 400)
    const { scope, path, offset = 0 } = parsed.data
    const root = await rootFor(scope)
    const target = await targetWithin(root, path)
    if (endpoint === '/list') {
      const entries = await readdir(target, { withFileTypes: true })
      // Check again before returning names if the directory was replaced during the read.
      if (await targetWithin(root, path) !== target) throw new PreviewError('目录已变化，请刷新。', 400)
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || collator.compare(a.name, b.name) || a.name.localeCompare(b.name))
      const directory = relative(root, target).split(sep).join('/')
      const page: WorkspaceDirectory = { root, path: directory, entries: entries.slice(offset, offset + 200).map(entry => ({ name: entry.name, path: [directory, entry.name].filter(Boolean).join('/'), kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })), ...(offset + 200 < entries.length ? { nextOffset: offset + 200 } : {}) }
      return context.json(page)
    }
    if (endpoint === '/image') {
      const image = await readSessionImagePreview(root, target, undefined, root)
      context.header('Content-Type', image.mime)
      context.header('X-Content-Type-Options', 'nosniff')
      context.header('X-Pi-Nest-File-Path', encodeURIComponent(image.path))
      return context.body(new Uint8Array(image.buffer))
    }
    return context.json(await readSessionFilePreview(root, target, undefined, root))
  })
  for (const endpoint of ['/text-page', '/stat']) routes.post(endpoint, async context => {
    const base = z.object({ scope: scopeSchema, path: pathSchema.min(1) }).strict()
    const schema = endpoint === '/text-page' ? base.extend(textPageRequestFields) : base
    const parsed = schema.safeParse(await context.req.json().catch(() => undefined))
    if (!parsed.success) return context.json({ error: '文件分页请求无效。' }, 400)
    const root = await rootFor(parsed.data.scope)
    const target = await targetWithin(root, parsed.data.path)
    const input = { ...parsed.data, cwd: root, path: target, allowedRoot: root, signal: context.req.raw.signal }
    return context.json(endpoint === '/stat' ? await readTextFileStat(input) : await readTextFilePage(input))
  })
  routes.post('/watch', async context => {
    const parsed = watchSchema.safeParse(await context.req.json().catch(() => undefined))
    if (!parsed.success) return context.json({ error: '目录观察请求无效。' }, 400)
    const root = await rootFor(parsed.data.scope)
    const paths = [...new Set(parsed.data.paths)]
    const targets = (await Promise.all(paths.map(async path => {
      try {
        const target = await targetWithin(root, path)
        if (!(await stat(target)).isDirectory()) throw new PreviewError('观察目标不是目录。', 400)
        return { path, target }
      } catch (error) {
        if (path && ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
        throw error
      }
    }))).filter(target => target !== undefined)
    context.header('Content-Type', 'application/x-ndjson')
    return stream(context, async output => {
      const watchers: FSWatcher[] = []
      const changed = new Set<string>()
      let timer: ReturnType<typeof setTimeout> | undefined
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let finish: () => void = () => undefined
      const done = new Promise<void>(resolve => { finish = resolve })
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        clearTimeout(timer); clearInterval(heartbeat)
        for (const watcher of watchers) watcher.close()
        finish()
      }
      const send = (value: object) => { if (!closed) void output.write(`${JSON.stringify(value)}\n`).catch(close) }
      output.onAbort(close)
      try {
        for (const { path, target } of targets) {
          const watcher = watch(target, { persistent: false }, () => {
            changed.add(path)
            timer ??= setTimeout(() => { timer = undefined; send({ type: 'change', paths: [...changed] }); changed.clear() }, 100)
          })
          watchers.push(watcher)
          watcher.on('error', () => { send({ type: 'error', message: '目录观察已中断，可手动刷新。' }); close() })
        }
        send({ type: 'ready' })
        heartbeat = setInterval(() => send({ type: 'ping' }), 15_000)
        heartbeat.unref()
        await done
      } catch { send({ type: 'error', message: '当前文件系统不支持自动观察，可手动刷新。' }) }
      finally { close() }
    })
  })
  return routes
}
