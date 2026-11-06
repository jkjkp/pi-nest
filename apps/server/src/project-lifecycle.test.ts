import { PiSessionIndex } from './session-index.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceDatabase } from './workspace-database.js'
import { ProjectRegistry } from './project-registry.js'
import { createApp } from './app.js'
import { RuntimeSecurity } from './runtime-security.js'
import { AttachmentStore } from './attachment-store.js'
import { SessionBranchStore } from './session-branch-store.js'
import { createSessionIndexFixture } from './test-fixtures/session-index.js'
import type { PiRuntimeRegistry } from './pi-runtime-registry.js'

vi.mock('@pi-nest/pi-adapter', async (original) => ({ ...await original<typeof import('@pi-nest/pi-adapter')>(), deletePiSession: vi.fn(async ({ sessionFile }: { sessionFile: string }) => { rmSync(sessionFile); return { method: 'trash' } }) }))
let directory: string
let db: WorkspaceDatabase
let projects: ProjectRegistry
let second: WorkspaceDatabase | undefined
const security = new RuntimeSecurity('http://localhost:31415')
const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/json' }
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'pi-nest-project-lifecycle-')))
  db = new WorkspaceDatabase(join(directory, 'workspace.sqlite'))
  projects = new ProjectRegistry(db)
})
afterEach(() => { db.close(); second?.close(); second = undefined; rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })
function fixture() {
  const cwd = join(directory, 'work'); mkdirSync(cwd)
  const sessionFile = join(directory, 'session.jsonl'); writeFileSync(sessionFile, 'original session')
  const sessions = createSessionIndexFixture([{ id: 'one', cwd, sessionFile, createdAt: '2026-10-01T00:00:00Z', firstMessage: 'original', name: undefined, updatedAt: undefined }])
  const runtime = { attachments: new AttachmentStore(join(directory, 'attachments')), deleteIdleSession: vi.fn(async (_id: string, remove: () => Promise<unknown>) => { await remove() }) } as unknown as PiRuntimeRegistry
  const app = createApp(runtime, security, projects, sessions.index, new SessionBranchStore(db))
  return { cwd, sessionFile, sessions, runtime, app }
}
it('keeps empty and removed projects across connections, restores the same identity, and never touches conversation files', async () => {
  const { cwd, sessionFile, app, sessions } = fixture()
  const first = await (await app.request('/api/workspace', { headers })).json()
  const project = first.projects[0]
  expect(first.sessions[0].projectId).toBe(project.id)
  expect((await app.request(`/api/projects/${project.id}`, { method: 'DELETE', headers })).status).toBe(204)
  second = new WorkspaceDatabase(db.path)
  const other = new ProjectRegistry(second)
  expect(other.list()).toEqual([])
  expect(other.list('removed')[0]?.id).toBe(project.id)
  expect(readFileSync(sessionFile, 'utf8')).toBe('original session')
  sessions.add({ id: 'external', cwd, sessionFile: join(directory, 'external.jsonl'), firstMessage: undefined, name: undefined, updatedAt: undefined })
  expect((await (await app.request('/api/workspace', { headers })).json()).projects).toEqual([])
  expect(other.list()).toEqual([])
  expect((await app.request(`/api/projects/${project.id}/restore`, { method: 'POST', headers })).status).toBe(204)
  const restored = await (await app.request('/api/workspace', { headers })).json()
  expect(restored.projects[0].id).toBe(project.id)
  expect(restored.sessions.map((session: { id: string }) => session.id)).toEqual(['one', 'external'])
  sessions.setSessions([])
  expect((await (await app.request('/api/workspace', { headers })).json()).projects[0].id).toBe(project.id)
})
it('registers a historical project before deleting its last conversation and keeps it after reload', async () => {
  const { app, sessionFile, cwd } = fixture()
  expect(projects.list()).toEqual([])
  expect((await app.request('/api/sessions/one', { method: 'DELETE' })).status).toBe(204)
  expect(existsSync(sessionFile)).toBe(false)
  const snapshot = await (await app.request('/api/workspace', { headers })).json()
  expect(snapshot.projects).toMatchObject([{ cwd }])
  expect(snapshot.sessions).toEqual([])
  expect(db.connection!.prepare('SELECT * FROM project_sessions').all()).toEqual([])
})
it('does not delete the original file when project metadata cannot be recorded', async () => {
  const { app, sessionFile, runtime } = fixture()
  db.close()
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect((await app.request('/api/sessions/one', { method: 'DELETE' })).status).toBe(503)
  expect(runtime.deleteIdleSession).not.toHaveBeenCalled()
  expect(readFileSync(sessionFile, 'utf8')).toBe('original session')
  expect((await app.request('/api/workspace', { headers })).status).toBe(503)
  quiet.mockRestore()
})
it('blocks project operations after removal even when native conversations still exist', async () => {
  const { cwd, app } = fixture()
  const [project] = (await (await app.request('/api/workspace', { headers })).json()).projects
  projects.remove(project.id)
  expect(await projects.authorize(cwd, createSessionIndexFixture().index)).toBe(false)
  expect((await app.request('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ cwd, prompt: 'new' }) })).status).toBe(404)
  expect((await app.request('/api/workspace-files', { method: 'POST', headers, body: JSON.stringify({ scope: { kind: 'project', cwd }, path: '.' }) })).status).not.toBe(200)
  expect(projects.open(cwd).id).toBe(project.id)
})
it('protects every project lifecycle route and makes repeated removal harmless', async () => {
  const { app } = fixture()
  const project = projects.create(directory, 'empty')
  for (const [path, method, body] of [
    [`/api/projects/${project.id}`, 'DELETE', undefined],
    [`/api/projects/${project.id}/restore`, 'POST', undefined],
    ['/api/projects/migration', 'POST', JSON.stringify({ paths: [project.cwd] })],
    ['/api/projects?state=removed', 'GET', undefined],
    ['/api/workspace', 'GET', undefined],
  ]) expect((await app.request(path!, { method, body })).status).toBe(403)
  for (let count = 0; count < 2; count++) expect((await app.request(`/api/projects/${project.id}`, { method: 'DELETE', headers })).status).toBe(204)
  expect(projects.list('removed')).toHaveLength(1)
})
it('imports legacy JSON once, preserves dates and backups, and never reactivates removed projects', () => {
  const legacy = join(directory, 'projects.json')
  const cwd = join(directory, 'gone')
  writeFileSync(legacy, JSON.stringify([{ cwd, createdAt: '2026-09-01T00:00:00Z' }]))
  projects = new ProjectRegistry(db, legacy)
  const [project] = projects.list()
  expect(project).toMatchObject({ cwd, createdAt: '2026-09-01T00:00:00Z' })
  expect(readFileSync(`${legacy}.pre-sqlite.bak`, 'utf8')).toBe(readFileSync(legacy, 'utf8'))
  projects.remove(project!.id)
  expect(new ProjectRegistry(db, legacy).list()).toEqual([])
  expect(projects.list('removed')[0]?.id).toBe(project!.id)
})

it('does not silently authorize a new symlink target for an offline directory imported from legacy JSON', () => {
  const cwd = join(directory, 'previously-canonical')
  const legacy = join(directory, 'projects.json')
  writeFileSync(legacy, JSON.stringify([{ cwd, createdAt: '2026-09-01T00:00:00Z' }]))
  projects = new ProjectRegistry(db, legacy)
  const other = join(directory, 'different-target')
  mkdirSync(other)
  symlinkSync(other, cwd, 'dir')
  expect(projects.has(cwd)).toBe(false)
  expect(projects.list()[0]?.cwd).toBe(cwd)
})
it('migrates browser visibility once globally without overwriting later restores', () => {
  const project = projects.create(directory, 'legacy-hidden')
  projects.migrateVisibility([project.cwd, join(directory, 'missing-hidden')])
  expect(projects.legacyVisibilityPending).toBe(false)
  expect(projects.list()).toEqual([])
  projects.restore(project.id)
  second = new WorkspaceDatabase(db.path)
  const other = new ProjectRegistry(second)
  other.migrateVisibility([project.cwd])
  expect(other.list()[0]?.id).toBe(project.id)
  expect(other.list('removed')).toHaveLength(1)
})
it('rejects conflicting native bindings without partially importing the batch', () => {
  projects.sync([{ id: 'one', cwd: join(directory, 'first') }])
  expect(() => projects.sync([{ id: 'new', cwd: join(directory, 'new') }, { id: 'one', cwd: join(directory, 'different') }])).toThrow('归属冲突')
  expect(projects.list()).toHaveLength(1)
  expect(db.connection!.prepare('SELECT session_id FROM project_sessions').all()).toEqual([{ session_id: 'one' }])
})

it('keeps an offline alias project identity and removal state when its directory becomes available', async () => {
  const target = join(directory, 'target')
  const alias = join(directory, 'alias')
  symlinkSync(target, alias, 'dir')
  const binding = { id: 'aliased-session', cwd: alias }
  projects.sync([binding])
  const [project] = projects.list()
  projects.remove(project!.id)
  mkdirSync(target)
  expect(projects.sync([binding]).get(binding.id)).toBe(project!.id)
  expect(projects.list()).toEqual([])
  expect(projects.list('removed')).toMatchObject([{ id: project!.id, cwd: target }])
  projects.restore(project!.id)
  expect(await projects.authorize(alias, createSessionIndexFixture().index)).toBe(true)
  expect(projects.open(alias).id).toBe(project!.id)
})

it('keeps a resolved alias binding through directory loss and a registry restart', () => {
  const target = join(directory, 'target')
  const alias = join(directory, 'alias')
  mkdirSync(target)
  symlinkSync(target, alias, 'dir')
  const binding = { id: 'aliased-session', cwd: alias }
  projects.sync([binding])
  const [project] = projects.list()
  rmSync(target, { recursive: true })
  second = new WorkspaceDatabase(db.path)
  const restarted = new ProjectRegistry(second)
  expect(restarted.sync([binding]).get(binding.id)).toBe(project!.id)
  expect(restarted.list()).toEqual([project])
  mkdirSync(target)
  expect(restarted.sync([binding]).get(binding.id)).toBe(project!.id)
  expect(restarted.open(alias).id).toBe(project!.id)
})

it('upgrades an offline v2 alias binding without changing identity or weakening directory authorization', async () => {
  const { default: Database } = await import('better-sqlite3')
  const target = join(directory, 'old-target')
  const alias = join(directory, 'old-alias')
  symlinkSync(target, alias, 'dir')
  const path = join(directory, 'v2.sqlite')
  const original = new Database(path)
  original.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, cwd TEXT UNIQUE, created_at TEXT, removed_at TEXT);
    CREATE TABLE project_sessions (session_id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id));
    CREATE TABLE workspace_migrations (name TEXT PRIMARY KEY, applied_at TEXT);
    PRAGMA user_version=2;`)
  original.prepare('INSERT INTO projects VALUES (?,?,?,NULL)').run('original-project', target, '2026-11-05T00:00:00Z')
  original.prepare('INSERT INTO project_sessions VALUES (?,?)').run('old-session', 'original-project')
  original.close()
  second = new WorkspaceDatabase(path)
  const upgraded = new ProjectRegistry(second)
  expect(upgraded.sync([{ id: 'old-session', cwd: alias }]).get('old-session')).toBe('original-project')
  expect(upgraded.list()).toMatchObject([{ id: 'original-project', cwd: target }])
  mkdirSync(target)
  expect(upgraded.sync([{ id: 'old-session', cwd: alias }]).get('old-session')).toBe('original-project')
  expect(upgraded.has(alias)).toBe(true)
  rmSync(alias)
  const other = join(directory, 'other-target'); mkdirSync(other); symlinkSync(other, alias, 'dir')
  expect(upgraded.has(alias)).toBe(false)
})
it('retains projects during incomplete or failed discovery and blocks corrupt legacy imports', () => {
  projects.sync([{ id: 'one', cwd: join(directory, 'lost') }])
  projects.sync([])
  expect(projects.list()).toHaveLength(1)
  const legacy = join(directory, 'broken.json'); writeFileSync(legacy, 'broken')
  const damaged = new ProjectRegistry(db, legacy)
  expect(damaged.health.available).toBe(false)
  expect(() => damaged.create(directory, 'must-not-exist')).toThrow('数据库不可用')
  expect(existsSync(join(directory, 'must-not-exist'))).toBe(false)
  expect(readFileSync(legacy, 'utf8')).toBe('broken')
})

it('persists an externally discovered project before any workspace request, even if its last file then vanishes', async () => {
  const sessionDirectory = join(directory, 'native', 'project')
  mkdirSync(sessionDirectory, { recursive: true })
  const file = join(sessionDirectory, 'external.jsonl')
  const cwd = join(directory, 'external-project')
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'external', cwd, timestamp: '2026-11-05T00:00:00Z' }) + '\n')
  const index = new PiSessionIndex({ directory: join(directory, 'native'), watch: false, reconcileIntervalMs: 0, reconcileWindowMs: 0, onDiscover: (session) => { projects.sync([session]) } })
  try {
    expect((await index.resolve('external'))?.id).toBe('external')
    expect(projects.list()).toMatchObject([{ cwd }])
    rmSync(file)
    expect(await index.resolve('external')).toBeUndefined()
    expect(projects.list()).toMatchObject([{ cwd }])
  } finally { index.close() }
})

it('reports a completed file deletion accurately if metadata cleanup fails afterwards', async () => {
  const { ProjectStorageError } = await import('./project-registry.js')
  const { app, sessionFile } = fixture()
  vi.spyOn(projects, 'forgetSession').mockImplementationOnce(() => { throw new ProjectStorageError('unavailable') })
  const response = await app.request('/api/sessions/one', { method: 'DELETE' })
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'SESSION_METADATA_CLEANUP_FAILED', error: expect.stringContaining('文件已删除') })
  expect(existsSync(sessionFile)).toBe(false)
  const snapshot = await (await app.request('/api/workspace', { headers })).json()
  expect(snapshot.projects).toHaveLength(1)
  expect(snapshot.sessions).toEqual([])
})
