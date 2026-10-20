import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionFilePreviewRoutes, readSessionFilePreview, readSessionImagePreview } from './session-file-preview.js'
import { RuntimeSecurity } from './runtime-security.js'
import { createApp } from './app.js'

const adapter = vi.hoisted(() => ({ listPiSessions: vi.fn() }))
vi.mock('@pi-nest/pi-adapter', async (original) => ({ ...await original<typeof import('@pi-nest/pi-adapter')>(), ...adapter }))
let directory: string
let cwd: string
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'pi-nest-preview-')))
  cwd = join(directory, 'project')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'a.ts'), 'hello\nworld')
  writeFileSync(join(directory, 'outside'), 'private')
  adapter.listPiSessions.mockResolvedValue([{ id: 'one', cwd }])
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('reads current text through a session-authorized route and rejects forged origins and bodies', async () => {
  const security = new RuntimeSecurity('http://localhost:31415')
  const app = createApp(undefined, security)
  const request = (headers: Record<string, string>, body = { path: 'a.ts' }) => app.request('/api/sessions/one/file-preview', { method: 'POST', headers, body: JSON.stringify(body) })
  const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/json' }
  expect((await request({})).status).toBe(403)
  expect((await request({ ...headers, origin: 'https://evil.example' })).status).toBe(403)
  expect((await request({ ...headers, 'x-pi-nest-token': 'wrong' })).status).toBe(403)
  expect((await request(headers)).status).toBe(200)
  expect(await (await request(headers)).json()).toEqual({ path: 'a.ts', content: 'hello\nworld' })
  writeFileSync(join(cwd, 'a.ts'), 'changed')
  const refreshed = await request(headers)
  expect(await refreshed.json()).toEqual({ path: 'a.ts', content: 'changed' })
  expect(refreshed.headers.get('cache-control')).toBe('no-store')
  expect((await request(headers, { path: '' })).status).toBe(400)
  expect((await request(headers, { path: 'a\0.ts' })).status).toBe(400)
  expect(await (await request(headers, { path: join(directory, 'outside') })).json()).toEqual({ path: join(directory, 'outside'), content: 'private' })
  expect((await request({ ...headers, origin: 'https://evil.example' }, { path: join(directory, 'outside') })).status).toBe(403)
  const routes = createSessionFilePreviewRoutes(security)
  expect((await routes.request('/sessions/missing/file-preview', { method: 'POST', headers, body: JSON.stringify({ path: 'a.ts' }) })).status).toBe(404)
})

it('reads parent paths, sibling projects and symlinks with canonical external paths', async () => {
  symlinkSync(join(directory, 'outside'), join(cwd, 'escape'))
  const sibling = join(directory, 'project-other')
  mkdirSync(sibling)
  writeFileSync(join(sibling, 'a'), 'private')
  for (const path of ['../outside', join(directory, 'outside'), 'escape']) {
    expect(await readSessionFilePreview(cwd, path)).toEqual({ path: join(directory, 'outside'), content: 'private' })
  }
  expect(await readSessionFilePreview(cwd, join(sibling, 'a'))).toEqual({ path: join(sibling, 'a'), content: 'private' })
  symlinkSync(join(cwd, 'a.ts'), join(cwd, 'alias'))
  expect(await readSessionFilePreview(cwd, 'alias')).toEqual({ path: 'a.ts', content: 'hello\nworld' })
})

it('bounds reads and refuses directories, binary data and unsupported encodings', async () => {
  writeFileSync(join(cwd, 'big'), Buffer.alloc(1_048_577, 'a'))
  writeFileSync(join(cwd, 'binary'), Buffer.from([65, 0, 66]))
  writeFileSync(join(cwd, 'encoding'), Buffer.from([255, 254, 65]))
  writeFileSync(join(cwd, 'empty'), '')
  await expect(readSessionFilePreview(cwd, 'big')).rejects.toMatchObject({ status: 413 })
  await expect(readSessionFilePreview(cwd, 'binary')).rejects.toMatchObject({ status: 415 })
  await expect(readSessionFilePreview(cwd, 'encoding')).rejects.toMatchObject({ status: 415 })
  await expect(readSessionFilePreview(cwd, '.')).rejects.toMatchObject({ status: 400 })
  await expect(readSessionFilePreview(cwd, 'deleted')).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readSessionFilePreview(cwd, 'empty')).content).toBe('')
})

it('resolves grep paths relative to its directory or single-file search scope', async () => {
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'a.ts'), 'scoped')
  expect(await readSessionFilePreview(cwd, 'a.ts', 'src')).toEqual({ path: 'src/a.ts', content: 'scoped' })
  expect(await readSessionFilePreview(cwd, 'a.ts', 'src/a.ts')).toEqual({ path: 'src/a.ts', content: 'scoped' })
  expect(await readSessionFilePreview(cwd, '../a.ts', 'src')).toEqual({ path: 'a.ts', content: 'hello\nworld' })
  await expect(readSessionFilePreview(cwd, 'wrong.ts', 'src/a.ts')).rejects.toMatchObject({ status: 400 })
  expect(await readSessionFilePreview(cwd, 'outside', '..')).toEqual({ path: join(directory, 'outside'), content: 'private' })
  expect(await readSessionFilePreview(cwd, 'outside', directory)).toEqual({ path: join(directory, 'outside'), content: 'private' })
  expect(await readSessionFilePreview(cwd, 'outside', join(directory, 'outside'))).toEqual({ path: join(directory, 'outside'), content: 'private' })
  expect(await readSessionFilePreview(cwd, join(directory, 'outside'), 'missing-scope')).toEqual({ path: join(directory, 'outside'), content: 'private' })
})

const pixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')
const pixelJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z', 'base64')
const pixelGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const pixelWebp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')

it('authorizes image bytes independently and chooses MIME from actual data rather than the extension', async () => {
  writeFileSync(join(cwd, '像素.jpg'), pixelPng)
  const security = new RuntimeSecurity('http://localhost:31415')
  const app = createApp(undefined, security)
  const request = (headers: Record<string, string>, body: object = { path: '像素.jpg' }) => app.request('/api/sessions/one/file-preview/image', { method: 'POST', headers, body: JSON.stringify(body) })
  const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/json' }
  expect((await request({})).status).toBe(403)
  expect((await request({ ...headers, origin: 'https://evil.example' })).status).toBe(403)
  expect((await request({ ...headers, 'x-pi-nest-token': 'wrong' })).status).toBe(403)
  const image = await request(headers)
  expect(image.status).toBe(200)
  expect(image.headers.get('content-type')).toBe('image/png')
  expect(image.headers.get('cache-control')).toBe('no-store')
  expect(image.headers.get('x-content-type-options')).toBe('nosniff')
  expect(decodeURIComponent(image.headers.get('x-pi-nest-file-path')!)).toBe('像素.jpg')
  expect(Buffer.from(await image.arrayBuffer())).toEqual(pixelPng)
  expect((await request(headers, { path: 'x', content: 'forged' })).status).toBe(400)
  expect((await request(headers, { path: 'x'.repeat(17_000) })).status).toBe(413)
  const outside = join(directory, '外部图片.png')
  writeFileSync(outside, pixelPng)
  const externalImage = await request(headers, { path: outside })
  expect(externalImage.status).toBe(200)
  expect(decodeURIComponent(externalImage.headers.get('x-pi-nest-file-path')!)).toBe(outside)
  expect(Buffer.from(await externalImage.arrayBuffer())).toEqual(pixelPng)
  expect((await request({ ...headers, 'x-pi-nest-token': 'wrong' }, { path: outside })).status).toBe(403)
})

it('allows raster formats, bounds image dimensions and bytes, and rejects corrupt or active content', async () => {
  for (const [name, bytes, mime] of [['pixel.png', pixelPng, 'image/png'], ['pixel.jpeg', pixelJpeg, 'image/jpeg'], ['pixel.gif', pixelGif, 'image/gif'], ['pixel.webp', pixelWebp, 'image/webp']] as const) {
    writeFileSync(join(cwd, name), bytes)
    expect((await readSessionImagePreview(cwd, name)).mime).toBe(mime)
  }
  writeFileSync(join(cwd, 'fake.png'), '<html><script>alert(1)</script></html>')
  writeFileSync(join(cwd, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
  writeFileSync(join(cwd, 'truncated.png'), pixelPng.subarray(0, 18))
  const forged = Buffer.from(pixelPng); forged[0] = 0
  writeFileSync(join(cwd, 'forged.png'), forged)
  for (const path of ['fake.png', 'vector.svg', 'truncated.png', 'forged.png']) await expect(readSessionImagePreview(cwd, path)).rejects.toMatchObject({ status: 415 })
  writeFileSync(join(cwd, 'large.png'), Buffer.alloc(10 * 1_048_576 + 1))
  await expect(readSessionImagePreview(cwd, 'large.png')).rejects.toMatchObject({ status: 413 })
  const enormous = Buffer.from(pixelPng)
  enormous.writeUInt32BE(40_000_001, 16)
  writeFileSync(join(cwd, 'enormous.png'), enormous)
  await expect(readSessionImagePreview(cwd, 'enormous.png')).rejects.toMatchObject({ status: 413 })
})

it('supports external image paths, search scopes and symlinks', async () => {
  writeFileSync(join(directory, 'private.png'), pixelPng)
  symlinkSync(join(directory, 'private.png'), join(cwd, 'escape.png'))
  for (const path of ['../private.png', join(directory, 'private.png'), 'escape.png']) {
    const image = await readSessionImagePreview(cwd, path)
    expect(image.path).toBe(join(directory, 'private.png'))
    expect(image.buffer).toEqual(pixelPng)
  }
  expect((await readSessionImagePreview(cwd, 'private.png', directory)).path).toBe(join(directory, 'private.png'))
  expect((await readSessionImagePreview(cwd, 'private.png', join(directory, 'private.png'))).mime).toBe('image/png')
  mkdirSync(join(cwd, 'images'))
  writeFileSync(join(cwd, 'images', 'pixel.png'), pixelPng)
  expect((await readSessionImagePreview(cwd, 'pixel.png', 'images')).path).toBe('images/pixel.png')
})


it('uses the session directory only as a path base, including an unavailable directory', async () => {
  const alias = join(directory, 'alias-project')
  symlinkSync(cwd, alias)
  expect(await readSessionFilePreview(alias, 'a.ts')).toEqual({ path: 'a.ts', content: 'hello\nworld' })
  expect(await readSessionFilePreview(join(directory, 'deleted-project'), join(directory, 'outside'))).toEqual({ path: join(directory, 'outside'), content: 'private' })
})

it.skipIf(process.platform === 'win32')('rejects an external FIFO without waiting for a writer', async () => {
  const fifo = join(directory, 'pipe')
  execFileSync('mkfifo', [fifo])
  await expect(readSessionFilePreview(cwd, fifo)).rejects.toMatchObject({ status: 400 })
})
