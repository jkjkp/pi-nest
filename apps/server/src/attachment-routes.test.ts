import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { AttachmentError, AttachmentStore } from './attachment-store.js'
import { createAttachmentRoutes } from './attachment-routes.js'
import { ProjectRegistry } from './project-registry.js'
import { RuntimeSecurity } from './runtime-security.js'
const adapter = vi.hoisted(() => ({ listPiSessions: vi.fn() }))
vi.mock('@pi-nest/pi-adapter', async (original) => ({ ...await original<typeof import('@pi-nest/pi-adapter')>(), ...adapter }))
let directory: string
let store: AttachmentStore
let app: Hono
const security = new RuntimeSecurity()
const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/octet-stream', 'x-pi-nest-file-name': encodeURIComponent('说明.html'), 'x-pi-nest-file-type': 'text/html', 'x-pi-nest-attachment-scope': encodeURIComponent(JSON.stringify({ kind: 'session', sessionId: 'a' })) }
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'pi-upload-api-'))); store = new AttachmentStore(directory); adapter.listPiSessions.mockResolvedValue([{ id: 'a' }, { id: 'b' }]); app = new Hono().route('/api/attachments', createAttachmentRoutes(store, security, new ProjectRegistry(join(directory, 'projects.json')))) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

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
