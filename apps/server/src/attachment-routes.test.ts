import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { preparePiImage } from '@pi-nest/pi-adapter'
import { AttachmentError, AttachmentStore } from './attachment-store.js'
import { createAttachmentRoutes } from './attachment-routes.js'
import { ProjectRegistry } from './project-registry.js'
import { RuntimeSecurity } from './runtime-security.js'
import { createSessionIndexFixture } from './test-fixtures/session-index.js'

vi.mock('@pi-nest/pi-adapter', async (original) => {
  const actual = await original<typeof import('@pi-nest/pi-adapter')>()
  return { ...actual, preparePiImage: vi.fn(actual.preparePiImage) }
})

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const imageStream = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(png); c.close() } })
let directory: string
let store: AttachmentStore
let app: Hono
const security = new RuntimeSecurity()
const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/octet-stream', 'x-pi-nest-file-name': encodeURIComponent('说明.html'), 'x-pi-nest-file-type': 'text/html', 'x-pi-nest-attachment-scope': encodeURIComponent(JSON.stringify({ kind: 'session', sessionId: 'a' })) }
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'pi-upload-api-'))); store = new AttachmentStore(directory); const sessionIndex = createSessionIndexFixture(['a', 'b'].map((id) => ({ id, cwd: directory, firstMessage: undefined, name: undefined, sessionFile: join(directory, `${id}.jsonl`), updatedAt: undefined }))); app = new Hono().route('/api/attachments', createAttachmentRoutes(store, security, new ProjectRegistry(join(directory, 'projects.json')), sessionIndex.index)) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

function thumbnail(id: string, sessionId = 'a') {
  return app.request(`/api/attachments/${id}/content?thumbnail=1`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'session', sessionId }),
  })
}

it('reads the original once per thumbnail request and skips conversion on a cache hit', async () => {
  const image = await store.upload(imageStream(), 'a', 'photo.png', 'image/png')
  const read = vi.spyOn(store, 'read')
  vi.mocked(preparePiImage).mockClear()

  const first = await thumbnail(image.id)
  expect(first.status).toBe(200)
  expect(Buffer.from(await first.arrayBuffer())).toEqual(png)
  expect(read).toHaveBeenCalledExactlyOnceWith(image.id, 'a')
  expect(preparePiImage).toHaveBeenCalledTimes(1)

  read.mockClear()
  vi.mocked(preparePiImage).mockClear()
  const cached = await thumbnail(image.id)
  expect(cached.status).toBe(200)
  expect(Buffer.from(await cached.arrayBuffer())).toEqual(png)
  expect(read).toHaveBeenCalledExactlyOnceWith(image.id, 'a')
  expect(preparePiImage).not.toHaveBeenCalled()
  expect(cached.headers.get('content-type')).toBe('image/png')
  expect(cached.headers.get('content-disposition')).toContain('inline;')
  expect(cached.headers.get('cache-control')).toBe('private, no-store')
  expect(cached.headers.get('x-content-type-options')).toBe('nosniff')
})

it.each(['source', 'mimeType', 'sha256'])('rebuilds a thumbnail with invalid cached %s using one original read', async (field) => {
  const image = await store.upload(imageStream(), 'a', 'photo.png', 'image/png')
  await thumbnail(image.id)
  const file = join(directory, `thumb-${image.id}`)
  const cached = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...cached, [field]: 'invalid' }))
  const read = vi.spyOn(store, 'read')
  vi.mocked(preparePiImage).mockClear()

  const response = await thumbnail(image.id)
  expect(response.status).toBe(200)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
  expect(read).toHaveBeenCalledTimes(1)
  expect(preparePiImage).toHaveBeenCalledTimes(1)
})

it.each([
  ['corrupt', 409, 'ATTACHMENT_CORRUPT'],
  ['missing', 404, 'ATTACHMENT_MISSING'],
  ['forbidden', 403, 'ATTACHMENT_FORBIDDEN'],
] as const)('rejects a %s original even with a valid thumbnail cache', async (kind, status, code) => {
  const image = await store.upload(imageStream(), 'a', 'photo.png', 'image/png')
  await thumbnail(image.id)
  const file = join(directory, `data-${image.id}`)
  if (kind === 'missing') rmSync(file)
  if (kind === 'corrupt') {
    const changed = Buffer.from(png)
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
    writeFileSync(file, changed)
  }
  const read = vi.spyOn(store, 'read')
  vi.mocked(preparePiImage).mockClear()

  const response = await thumbnail(image.id, kind === 'forbidden' ? 'b' : 'a')
  expect(response.status).toBe(status)
  await expect(response.json()).resolves.toMatchObject({ code })
  expect(read).toHaveBeenCalledTimes(1)
  expect(preparePiImage).not.toHaveBeenCalled()
})

it('rejects thumbnail requests for ordinary files', async () => {
  const file = await store.upload(new ReadableStream({ start(c) { c.enqueue(Buffer.from('text')); c.close() } }), 'a', 'notes.txt', 'text/plain')
  const read = vi.spyOn(store, 'read')
  expect((await thumbnail(file.id)).status).toBe(415)
  expect(read).toHaveBeenCalledTimes(1)
})

it.each(['EPERM', 'ENOSPC'])('logs %s and returns an actionable storage error without internal details', async (code) => {
  const cause = Object.assign(new Error('private disk path'), { code, syscall: 'fsync' })
  vi.spyOn(store, 'upload').mockRejectedValueOnce(cause)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const response = await app.request('/api/attachments', { method: 'POST', headers, body: 'file' })
  expect(response.status).toBe(500)
  await expect(response.json()).resolves.toEqual({ error: '附件保存或读取失败，请检查磁盘空间及目录权限后重试。', code: 'ATTACHMENT_STORAGE_FAILED' })
  expect(log).toHaveBeenCalledExactlyOnceWith('Attachment processing failed', { method: 'POST', path: '/api/attachments', cause })
})

it('returns a distinct decode failure and logs its cause rather than claiming a disk failure', async () => {
  const cause = new Error('decoder failed')
  const error = new AttachmentError('图片无法解码或压缩，请换一张图片。', 415, 'ATTACHMENT_IMAGE_DECODE_FAILED', { cause })
  vi.spyOn(store, 'upload').mockRejectedValueOnce(error)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const response = await app.request('/api/attachments', { method: 'POST', headers, body: 'file' })
  expect(response.status).toBe(415)
  await expect(response.json()).resolves.toEqual({ error: error.message, code: error.code })
  expect(log).toHaveBeenCalledOnce()
})

it('requires both the configured origin and token on upload and content reads', async () => {
  for (const missing of ['origin', 'x-pi-nest-token']) {
    const h = { ...headers }; delete h[missing as keyof typeof h]
    expect((await app.request('/api/attachments', { method: 'POST', headers: h, body: 'file' })).status).toBe(403)
  }
})
it('uploads original bytes and forces HTML downloads without exposing disk paths', async () => {
  const uploaded = await app.request('/api/attachments', { method: 'POST', headers, body: '<script>alert(1)</script>' })
  expect(uploaded.status).toBe(201)
  const { attachment } = await uploaded.json()
  expect(JSON.stringify(attachment)).not.toContain(directory)
  const response = await app.request(`/api/attachments/${attachment.id}/content`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'session', sessionId: 'a' }) })
  expect(response.headers.get('content-type')).toBe('application/octet-stream')
  expect(response.headers.get('content-disposition')).toContain('attachment;')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await response.text()).toBe('<script>alert(1)</script>')
  expect((await app.request(`/api/attachments/${attachment.id}/content`, { method: 'POST', headers, body: JSON.stringify({ kind: 'session', sessionId: 'b' }) })).status).toBe(403)
})
it('accepts a registered draft without creating a session and rejects unknown projects', async () => {
  new ProjectRegistry(join(directory, 'projects.json')).open(directory)
  const draftId = randomUUID()
  const scope = { kind: 'draft', draftId, cwd: directory }
  const result = await app.request('/api/attachments', { method: 'POST', headers: { ...headers, 'x-pi-nest-attachment-scope': encodeURIComponent(JSON.stringify(scope)) }, body: 'file' })
  expect(result.status).toBe(201)
  const { attachment } = await result.json()
  expect(store.read(attachment.id, `draft:${draftId}:${directory}`).bytes.toString()).toBe('file')
  const rejected = await app.request('/api/attachments', { method: 'POST', headers: { ...headers, 'x-pi-nest-attachment-scope': encodeURIComponent(JSON.stringify({ ...scope, cwd: '/unknown' })) }, body: 'file' })
  expect(rejected.status).toBe(403)
})
