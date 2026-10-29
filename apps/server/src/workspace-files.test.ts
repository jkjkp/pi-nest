import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join, win32, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { Hono } from 'hono'
import { RuntimeSecurity } from './runtime-security.js'
import { ProjectRegistry } from './project-registry.js'
import { createSessionIndexFixture } from './test-fixtures/session-index.js'
import { createWorkspaceFileRoutes } from './workspace-files.js'
import { isWorkspacePath } from './workspace-file-path.js'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-nest-files-')); dirs.push(dir)
  const root = join(dir, 'project'); await mkdir(root); await mkdir(join(root, 'src'))
  await writeFile(join(root, '.env.example'), 'EXAMPLE=true')
  await writeFile(join(root, 'fs-rules.yaml'), 'rules: []')
  await writeFile(join(dir, 'secret'), 'private')
  await symlink(join(dir, 'secret'), join(root, 'escape'))
  const security = new RuntimeSecurity()
  const projects = new ProjectRegistry(join(dir, 'projects.json')); projects.open(root)
  const sessions = createSessionIndexFixture([{ id: 's', name: 'Test', firstMessage: '', updatedAt: new Date().toISOString(), cwd: root, sessionFile: join(dir, 's.jsonl') }]).index
  const app = new Hono().route('/api/workspace-files', createWorkspaceFileRoutes(security, projects, sessions))
  const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/json' }
  const request = (endpoint: string, body: unknown, auth = headers) => app.request(`/api/workspace-files/${endpoint}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })
  return { root, request, dir }
}
it('lists authorized projects without a session, including dotfiles and YAML', async () => {
  const { root, request } = await fixture()
  const response = await request('list', { scope: { kind: 'project', cwd: root }, path: '' })
  expect(response.status).toBe(200)
  const body = await response.json() as { entries: { name: string; kind: string }[] }
  expect(body.entries[0]).toMatchObject({ name: 'src', kind: 'directory' })
  expect(body.entries).toContainEqual(expect.objectContaining({ name: 'fs-rules.yaml' }))
  expect(body.entries).toContainEqual(expect.objectContaining({ name: '.env.example' }))
  expect(body.entries).toContainEqual(expect.objectContaining({ name: 'escape', kind: 'link' }))
  expect((await request('list', { scope: { kind: 'session', id: 's' }, path: '' })).status).toBe(200)
})
it('guards authentication, unknown scopes, traversal and symlink escapes', async () => {
  const { root, request } = await fixture()
  const scope = { kind: 'project', cwd: root }
  expect((await request('list', { scope, path: '' }, {} as never)).status).toBe(403)
  expect((await request('list', { scope: { kind: 'project', cwd: tmpdir() }, path: '' })).status).toBe(404)
  for (const path of ['../secret', 'escape']) {
    expect((await request('preview', { scope, path })).status).toBe(403)
    expect((await request('list', { scope, path })).status).toBe(403)
  }
  expect((await request('preview', { scope, path: 'fs-rules.yaml' })).status).toBe(200)
  expect((await request('list', { scope, path: 'missing' })).status).toBe(404)
})
it('bounds directory responses and supports loading the next page', async () => {
  const { root, request } = await fixture()
  await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(join(root, `file-${i}`), '')))
  const input = { scope: { kind: 'project', cwd: root }, path: '' }
  const first = await (await request('list', input)).json() as { entries: unknown[]; nextOffset: number }
  expect(first.entries).toHaveLength(200)
  const next = await (await request('list', { ...input, offset: first.nextOffset })).json() as { entries: unknown[]; nextOffset?: number }
  expect(next.entries.length).toBeGreaterThan(0)
  expect(next.nextOffset).toBeUndefined()
})
it('checks drive boundaries, UNC roots, sibling prefixes and POSIX paths', () => {
  expect(isWorkspacePath('C:\\project', 'C:\\project\\目录\\a.ts', win32)).toBe(true)
  expect(isWorkspacePath('C:\\project', 'D:\\project\\a.ts', win32)).toBe(false)
  expect(isWorkspacePath('C:\\project', 'C:\\project-other\\a.ts', win32)).toBe(false)
  expect(isWorkspacePath('\\\\server\\share\\project', '\\\\server\\share\\other', win32)).toBe(false)
  expect(isWorkspacePath('/project', '/project/文件 #.ts', posix)).toBe(true)
  expect(isWorkspacePath('/project', '/project-other/a', posix)).toBe(false)
})

it('streams directory changes and releases the subscription when the reader closes', async () => {
  const { root, request } = await fixture()
  const response = await request('watch', { scope: { kind: 'project', cwd: root }, paths: ['', 'missing'] })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"ready"')
    await writeFile(join(root, 'new.txt'), 'changed')
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"change"')
  } finally { await reader.cancel() }
})

it('authorizes a registered project through its filesystem alias without any sessions', async () => {
  const { root, dir } = await fixture()
  const alias = join(dir, 'project-alias'); await symlink(root, alias)
  const security = new RuntimeSecurity()
  const projects = new ProjectRegistry(join(dir, 'only-projects.json')); projects.open(root)
  const app = new Hono().route('/files', createWorkspaceFileRoutes(security, projects, createSessionIndexFixture([]).index))
  const response = await app.request('/files/list', { method: 'POST', headers: { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/json' }, body: JSON.stringify({ scope: { kind: 'project', cwd: alias }, path: '' }) })
  expect(response.status).toBe(200)
})

it('pages large project files, checks metadata and refuses stale or escaping cursors', async () => {
  const { root, request } = await fixture()
  await writeFile(join(root, 'large.log'), 'row\n'.repeat(400_000))
  const input = { scope: { kind: 'project', cwd: root }, path: 'large.log' }
  const stat = await (await request('stat', input)).json() as { fileBytes: number; version: string }
  expect(stat.fileBytes).toBe(1_600_000)
  const page = await (await request('text-page', input)).json() as { text: string; nextCursor: unknown }
  expect(page.text.length).toBeLessThanOrEqual(262_144)
  expect((await request('text-page', { ...input, cursor: { offset: -1 } })).status).toBe(400)
  expect((await request('text-page', { ...input, path: 'escape' })).status).toBe(403)
  await writeFile(join(root, 'large.log'), 'new')
  const changed = await request('text-page', { ...input, cursor: page.nextCursor })
  expect(changed.status).toBe(409)
  expect(await changed.json()).toMatchObject({ code: 'FILE_VERSION_CHANGED' })
})
