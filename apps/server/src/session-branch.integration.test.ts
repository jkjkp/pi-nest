import { AttachmentStore } from './attachment-store.js'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import { listPiSessions, readPiSessionHistory, readPiSessionTurnIndex, renamePiSession } from '@pi-nest/pi-adapter'
import { SessionHistorySnapshots } from './session-history-snapshots.js'
import { createSessionRoutes } from './session-routes.js'
import type { PiRuntimeRegistry } from './pi-runtime-registry.js'

vi.mock('@pi-nest/pi-adapter', async (original) => ({
  ...await original<typeof import('@pi-nest/pi-adapter')>(),
  listPiSessions: vi.fn(),
}))

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

it('clones the native snapshot after runtime shutdown writes, and keeps fork revision protection', async () => {
  directory = mkdtempSync(join(tmpdir(), 'pi-nest-clone-route-'))
  const sessionFile = join(directory, 'source.jsonl')
  const timestamp = '2026-10-16T00:00:00.000Z'
  writeFileSync(sessionFile, [
    { type: 'session', version: 3, id: 'source', cwd: directory, timestamp },
    { type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: 'Original question', timestamp: Date.parse(timestamp) } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const binding = { sessionFile, expectedSessionId: 'source', expectedCwd: directory }
  const old = readPiSessionTurnIndex(binding)
  vi.mocked(listPiSessions).mockResolvedValue([{ id: 'source', cwd: directory, sessionFile, createdAt: timestamp, updatedAt: timestamp, name: undefined, firstMessage: 'Original question' }])
  const finish = vi.fn()
  let shutdownComplete!: () => void
  const registry = { attachments: new AttachmentStore(), beginMutation: vi.fn(() => new Promise<() => void>((resolve) => {
    shutdownComplete = () => {
      renamePiSession({ ...binding, name: 'Shutdown metadata' })
      resolve(finish)
    }
  })) }
  const app = new Hono().route('/api', createSessionRoutes(registry as unknown as PiRuntimeRegistry))
  const pending = app.request('/api/sessions/source/branch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'clone' }),
  })
  await vi.waitFor(() => expect(registry.beginMutation).toHaveBeenCalledWith('source', undefined))
  expect(readdirSync(directory)).toEqual(['source.jsonl'])
  shutdownComplete()
  const response = await pending
  expect(response.status).toBe(201)
  const result = await response.json()
  expect(result.session).toMatchObject({ cwd: directory, name: 'Shutdown metadata（副本）', parentSessionId: 'source' })
  expect(result.session.id).not.toBe('source')
  expect(result.draft).toBe('')
  expect(result.session.sessionFile).toBeUndefined()
  const childFile = join(directory, readdirSync(directory).find((file) => file !== 'source.jsonl')!)
  const sourceBytes = readFileSync(sessionFile)
  const childHistory = readPiSessionHistory({ sessionFile: childFile, expectedSessionId: result.session.id, expectedCwd: directory }).entries
  expect(childHistory.slice(0, -1)).toEqual(readPiSessionHistory(binding).entries)
  expect(childHistory.at(-1)?.raw).toMatchObject({ type: 'session_info', name: result.session.name })
  expect(readPiSessionTurnIndex(binding).revision).not.toBe(old.revision)
  registry.beginMutation.mockResolvedValueOnce(finish)
  const fork = await app.request('/api/sessions/source/branch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'fork', entryId: 'user', revision: old.revision }),
  })
  expect(fork.status).toBe(409)
  expect(await fork.json()).toMatchObject({ code: 'HISTORY_REVISION_CHANGED' })
  expect(readFileSync(sessionFile)).toEqual(sourceBytes)
  expect(readdirSync(directory)).toHaveLength(2)
  expect(finish).toHaveBeenCalledTimes(2)
})

it('numbers clones within the project and persists names when cloning a copy', async () => {
  directory = mkdtempSync(join(tmpdir(), 'pi-nest-clone-names-'))
  const sessionFile = join(directory, 'source.jsonl')
  const timestamp = new Date().toISOString()
  writeFileSync(sessionFile, [
    { type: 'session', version: 3, id: 'source', cwd: directory, timestamp },
    { type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: '登录接口排查', timestamp: Date.parse(timestamp) } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const sessions: Awaited<ReturnType<typeof listPiSessions>> = [
    { id: 'source', cwd: directory, sessionFile, updatedAt: timestamp, name: undefined, firstMessage: '登录接口排查' },
    { id: 'foreign', cwd: join(directory, 'other'), sessionFile: '/unused', updatedAt: timestamp, name: '登录接口排查（副本）', firstMessage: undefined },
  ]
  vi.mocked(listPiSessions).mockImplementation(async () => sessions)
  const finish = vi.fn()
  const registry = { attachments: new AttachmentStore(), beginMutation: vi.fn(async () => finish) }
  const app = new Hono().route('/api', createSessionRoutes(registry as unknown as PiRuntimeRegistry))
  async function clone(id: string, expectedName: string) {
    const response = await app.request(`/api/sessions/${id}/branch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'clone' }),
    })
    expect(response.status).toBe(201)
    const result = await response.json()
    expect(result.session.name).toBe(expectedName)
    const childFile = readdirSync(directory!).find((file) => file.includes(result.session.id))!
    const history = readPiSessionHistory({ sessionFile: join(directory!, childFile), expectedSessionId: result.session.id, expectedCwd: directory })
    expect(history.entries.at(-1)?.raw).toMatchObject({ type: 'session_info', name: expectedName })
    sessions.push({ ...result.session, sessionFile: join(directory!, childFile) })
    return result.session.id as string
  }
  const sourceBytes = readFileSync(sessionFile)
  const first = await clone('source', '登录接口排查（副本）')
  sessions.push({ id: 'occupied', cwd: directory, sessionFile: '/unused', updatedAt: timestamp, name: undefined, firstMessage: '登录接口排查（副本 2）' })
  await clone('source', '登录接口排查（副本 3）')
  await clone(first, '登录接口排查（副本 4）')
  expect(readFileSync(sessionFile)).toEqual(sourceBytes)
  expect(finish).toHaveBeenCalledTimes(3)
})

it('serves pinned native history, pagination and index over HTTP during generation', async () => {
  directory = mkdtempSync(join(tmpdir(), 'pi-nest-live-history-route-'))
  const timestamp = '2026-10-17T00:00:00Z'
  const session = { id: 'source', cwd: directory, sessionFile: join(directory, 'native.jsonl'), createdAt: timestamp, updatedAt: timestamp, firstMessage: 'first', name: undefined }
  const lines = [{ type: 'session', version: 3, id: session.id, cwd: directory, timestamp }, ...['first', 'second'].map((id, index) => ({ type: 'message', id, parentId: index ? 'first' : null, timestamp, message: { role: 'user', content: id, timestamp: Date.parse(timestamp) } }))]
  writeFileSync(session.sessionFile, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  vi.mocked(listPiSessions).mockResolvedValue([session])
  const history = new SessionHistorySnapshots()
  history.pin(session, 'live')
  const registry = { attachments: new AttachmentStore(), history, isPromptStreaming: () => true }
  const app = new Hono().route('/api', createSessionRoutes(registry as unknown as PiRuntimeRegistry))
  appendFileSync(session.sessionFile, JSON.stringify({ type: 'message', id: 'live-user', parentId: 'second', timestamp, message: { role: 'user', content: 'third', timestamp: Date.parse(timestamp) } }) + '\n')
  const response = await app.request('/api/sessions/source/history?limit=1')
  expect(response.status).toBe(200)
  const latest = await response.json()
  expect(latest.entries.map((entry: { id: string }) => entry.id)).toEqual(['second'])
  const earlier = await app.request(`/api/sessions/source/history?limit=1&revision=${latest.revision}&before=${latest.beforeCursor}`)
  expect(earlier.status).toBe(200)
  expect((await earlier.json()).entries[0].id).toBe('first')
  const index = await app.request(`/api/sessions/source/turn-index?revision=${latest.revision}`)
  expect(index.status).toBe(200)
  expect((await index.json()).entries).toHaveLength(2)
  history.unpin(session, 'live')
  const completed = await (await app.request('/api/sessions/source/history?limit=1')).json()
  expect(completed.entries[0]).toMatchObject({ id: 'live-user', runId: 'live', runIndex: 0 })
  expect(completed.session.sessionFile).toBeUndefined()
})


it.each(['session_info', 'custom', 'message', 'model_change', 'context_edit', 'branch'])(
  'checks fork history before shutdown and only accepts appended metadata (%s)', async (change) => {
    directory = mkdtempSync(join(tmpdir(), 'pi-nest-fork-shutdown-'))
    const sessionFile = join(directory, 'source.jsonl')
    const timestamp = '2026-10-20T00:00:00.000Z'
    const session = { id: 'source', cwd: directory, sessionFile, createdAt: timestamp, updatedAt: timestamp, name: undefined, firstMessage: 'first' }
    writeFileSync(sessionFile, [
      { type: 'session', version: 3, id: 'source', cwd: directory, timestamp },
      { type: 'message', id: 'first', parentId: null, timestamp, message: { role: 'user', content: 'first', timestamp: Date.parse(timestamp) } },
      { type: 'message', id: 'selected', parentId: 'first', timestamp, message: { role: 'user', content: 'full draft', timestamp: Date.parse(timestamp) } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    const binding = { sessionFile, expectedSessionId: 'source', expectedCwd: directory }
    const index = readPiSessionTurnIndex(binding)
    vi.mocked(listPiSessions).mockResolvedValue([session])
    const finish = vi.fn()
    const registry = { attachments: new AttachmentStore(), beginMutation: vi.fn(async (_id: string, beforeUnload?: () => void) => {
      beforeUnload?.()
      const entry = { id: 'shutdown', parentId: 'selected', timestamp, ...({
        session_info: { type: 'session_info', name: 'Shutdown name' },
        custom: { type: 'custom', customType: 'extension-state', data: { saved: true } },
        message: { type: 'message', message: { role: 'user', content: 'new question', timestamp: Date.parse(timestamp) } },
        model_change: { type: 'model_change', provider: 'fixture', modelId: 'other' },
        context_edit: { type: 'context_edit', targetId: 'first', replacement: null },
        branch: { type: 'custom', customType: 'extension-state', parentId: 'first' },
      }[change]) }
      appendFileSync(sessionFile, JSON.stringify(entry) + '\n')
      return finish
    }) }
    const app = new Hono().route('/api', createSessionRoutes(registry as unknown as PiRuntimeRegistry))
    const request = () => app.request('/api/sessions/source/branch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'fork', entryId: 'selected', revision: index.revision }),
    })
    const response = await request()
    const metadataOnly = change === 'session_info' || change === 'custom'
    expect(response.status).toBe(metadataOnly ? 201 : 409)
    const result = await response.json()
    if (metadataOnly) {
      expect(result.draft).toBe('full draft')
      const childFile = join(directory, readdirSync(directory).find((file) => file !== 'source.jsonl')!)
      expect(readPiSessionHistory({ sessionFile: childFile, expectedSessionId: result.session.id, expectedCwd: directory }).entries.map((entry) => entry.id)).toEqual(['first'])
    } else expect(result.code).toBe('HISTORY_REVISION_CHANGED')
    expect(readdirSync(directory)).toHaveLength(metadataOnly ? 2 : 1)
    expect(finish).toHaveBeenCalledOnce()
    // A revision already stale before shutdown must never be upgraded automatically.
    const bytes = readFileSync(sessionFile)
    expect((await request()).status).toBe(409)
    expect(readFileSync(sessionFile)).toEqual(bytes)
    expect(finish).toHaveBeenCalledOnce()
  },
)
