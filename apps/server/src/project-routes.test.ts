import { AttachmentStore } from './attachment-store.js'
import { selectProjectFolder } from './project-folder-picker.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectRegistry } from './project-registry.js'
import { createApp } from './app.js'
import { createSessionIndexFixture } from './test-fixtures/session-index.js'
import { RuntimeSecurity } from './runtime-security.js'
import type { PiRuntimeRegistry } from './pi-runtime-registry.js'

vi.mock('./project-folder-picker.js', () => ({ selectProjectFolder: vi.fn() }))

const adapter = vi.hoisted(() => ({ createPiSession: vi.fn() }))
vi.mock('@pi-nest/pi-adapter', async (original) => ({ ...await original<typeof import('@pi-nest/pi-adapter')>(), ...adapter }))
let directory: string
let projects: ProjectRegistry
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'pi-nest-projects-')))
  projects = new ProjectRegistry(join(directory, 'state', 'projects.json'))
  adapter.createPiSession.mockReset()
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

it('persists empty projects across registry instances and deduplicates real paths', () => {
  const cwd = join(directory, 'existing')
  mkdirSync(cwd)
  const first = projects.open(cwd)
  const alias = join(directory, 'alias')
  symlinkSync(cwd, alias)
  expect(projects.open(alias)).toEqual(first)
  expect(new ProjectRegistry(projects.path).list()).toEqual([first])
  expect(projects.has(cwd)).toBe(true)
  expect(statSync(projects.path).mode & 0o777).toBe(0o600)
  expect(adapter.createPiSession).not.toHaveBeenCalled()
})

it('creates only a new direct child and never overwrites existing files or directories', () => {
  const created = projects.create(directory, 'new-project')
  writeFileSync(join(created.cwd, 'keep.txt'), 'keep')
  expect(() => projects.create(directory, 'new-project')).toThrow()
  expect(readFileSync(join(created.cwd, 'keep.txt'), 'utf8')).toBe('keep')
  for (const name of ['../escape', '.', '..', '/absolute', 'nested/folder', 'nested\\folder', ' ']) expect(() => projects.create(directory, name)).toThrow()
  expect(() => projects.open('relative')).toThrow()
  expect(() => projects.open(join(directory, 'missing'))).toThrow()
  expect(() => projects.open(join(created.cwd, 'keep.txt'))).toThrow()
})

it('does not overwrite a damaged registry or create a folder before detecting the damage', () => {
  mkdirSync(join(directory, 'state'))
  writeFileSync(projects.path, 'broken')
  expect(() => projects.create(directory, 'new-project')).toThrow('项目登记文件')
  expect(readFileSync(projects.path, 'utf8')).toBe('broken')
  expect(() => statSync(join(directory, 'new-project'))).toThrow()
})

it('secures folder operations and allows the first Pi prompt only in an explicitly registered directory', async () => {
  const security = new RuntimeSecurity('http://localhost:31415')
  const runtime = { attachments: new AttachmentStore(), beginPrompt: vi.fn(() => ({ accepted: Promise.resolve() })) } as unknown as PiRuntimeRegistry
  const app = createApp(runtime, security, projects, createSessionIndexFixture().index)
  const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/json' }
  const request = { kind: 'create', parent: directory, name: 'new-project' }
  expect((await app.request('/api/projects', { method: 'POST', body: JSON.stringify(request) })).status).toBe(403)
  expect((await app.request('/api/projects', { method: 'POST', headers: { ...headers, origin: 'http://evil.example' }, body: JSON.stringify(request) })).status).toBe(403)
  expect(projects.list()).toEqual([])
  const response = await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify(request) })
  expect(response.status).toBe(201)
  const { project } = await response.json()
  expect(project.cwd).toBe(join(directory, 'new-project'))
  expect(adapter.createPiSession).not.toHaveBeenCalled()
  expect((await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify(request) })).status).toBe(409)
  expect((await app.request('/api/projects', { headers })).status).toBe(200)
  expect((await app.request('/api/projects')).status).toBe(403)
  const body = JSON.stringify({ cwd: project.cwd, prompt: 'first question' })
  expect((await app.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(403)
  for (const path of ['/api/sessions', '/api/projects/reveal']) {
    const expired = await app.request(path, { method: 'POST', headers: { ...headers, 'x-pi-nest-token': 'expired' }, body: path.endsWith('/reveal') ? JSON.stringify({ cwd: project.cwd }) : body })
    expect(expired.status).toBe(403)
    await expect(expired.json()).resolves.toMatchObject({ code: 'RUNTIME_TOKEN_INVALID' })
  }
  expect(adapter.createPiSession).not.toHaveBeenCalled()
  expect(runtime.beginPrompt).not.toHaveBeenCalled()
  adapter.createPiSession.mockReturnValue({ id: 'new-session', cwd: project.cwd, sessionFile: '/fixture/session.jsonl', createdAt: '2026-10-17T00:00:00Z' })
  const session = await app.request('/api/sessions', { method: 'POST', headers, body })
  expect(session.status).toBe(201)
  expect(adapter.createPiSession).toHaveBeenCalledExactlyOnceWith(project.cwd)
  expect(runtime.beginPrompt).toHaveBeenCalledWith(expect.objectContaining({ cwd: project.cwd }), 'first question', undefined, undefined)
  const unregistered = JSON.stringify({ cwd: directory, prompt: 'question' })
  expect((await app.request('/api/sessions', { method: 'POST', headers, body: unregistered })).status).toBe(404)
})


it('requires authorization for the native picker and does not register selected folders', async () => {
  const security = new RuntimeSecurity('http://localhost:31415')
  const app = createApp(undefined, security, projects, createSessionIndexFixture().index)
  const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/json' }
  vi.mocked(selectProjectFolder).mockReset().mockResolvedValue(directory)
  expect((await app.request('/api/projects/select-folder', { method: 'POST', body: '{}' })).status).toBe(403)
  expect((await app.request('/api/projects/select-folder', { method: 'POST', headers: { ...headers, origin: 'http://evil.example' }, body: '{}' })).status).toBe(403)
  expect(selectProjectFolder).not.toHaveBeenCalled()
  expect((await app.request('/api/projects/select-folder', { method: 'POST', headers, body: '{"extra":true}' })).status).toBe(400)
  const selected = await app.request('/api/projects/select-folder', { method: 'POST', headers, body: JSON.stringify({ cwd: directory }) })
  expect(await selected.json()).toEqual({ cwd: directory })
  expect(selectProjectFolder).toHaveBeenCalledExactlyOnceWith(directory)
  expect(projects.list()).toEqual([])
  vi.mocked(selectProjectFolder).mockResolvedValue(null)
  const cancelled = await app.request('/api/projects/select-folder', { method: 'POST', headers, body: '{}' })
  expect(await cancelled.json()).toEqual({ cwd: null })
})
