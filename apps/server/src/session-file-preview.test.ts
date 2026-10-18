import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionFilePreviewRoutes, readSessionFilePreview } from './session-file-preview.js'
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
  expect((await request(headers)).status).toBe(200)
  expect(await (await request(headers)).json()).toEqual({ path: 'a.ts', content: 'hello\nworld' })
  writeFileSync(join(cwd, 'a.ts'), 'changed')
  const refreshed = await request(headers)
  expect(await refreshed.json()).toEqual({ path: 'a.ts', content: 'changed' })
  expect(refreshed.headers.get('cache-control')).toBe('no-store')
  expect((await request(headers, { path: '' })).status).toBe(400)
  const routes = createSessionFilePreviewRoutes(security)
  expect((await routes.request('/sessions/missing/file-preview', { method: 'POST', headers, body: JSON.stringify({ path: 'a.ts' }) })).status).toBe(404)
})

it('rejects traversal, sibling-prefix paths and symlinks escaping the session project', async () => {
  symlinkSync(join(directory, 'outside'), join(cwd, 'escape'))
  const sibling = join(directory, 'project-other')
  mkdirSync(sibling)
  writeFileSync(join(sibling, 'a'), 'private')
  for (const path of ['../outside', join(directory, 'outside'), join(sibling, 'a'), 'escape']) {
    await expect(readSessionFilePreview(cwd, path)).rejects.toMatchObject({ status: 403 })
  }
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
  await expect(readSessionFilePreview(cwd, '../a.ts', 'src')).rejects.toMatchObject({ status: 403 })
  await expect(readSessionFilePreview(cwd, 'wrong.ts', 'src/a.ts')).rejects.toMatchObject({ status: 400 })
  await expect(readSessionFilePreview(cwd, 'outside', '..')).rejects.toMatchObject({ status: 403 })
})
