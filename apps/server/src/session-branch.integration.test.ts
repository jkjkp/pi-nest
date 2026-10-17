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
  const registry = { beginMutation: vi.fn(() => new Promise<() => void>((resolve) => {
    shutdownComplete = () => {
      renamePiSession({ ...binding, name: 'Shutdown metadata' })
      resolve(finish)
    }
  })) }
  const app = new Hono().route('/api', createSessionRoutes(registry as unknown as PiRuntimeRegistry))
  const pending = app.request('/api/sessions/source/branch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'clone' }),
  })
  await vi.waitFor(() => expect(registry.beginMutation).toHaveBeenCalledWith('source'))
  expect(readdirSync(directory)).toEqual(['source.jsonl'])
  shutdownComplete()
  const response = await pending
  expect(response.status).toBe(201)
  const result = await response.json()
  expect(result.session).toMatchObject({ cwd: directory, name: 'Shutdown metadata' })
  expect(result.session.id).not.toBe('source')
  expect(result.draft).toBe('')
  expect(result.session.sessionFile).toBeUndefined()
  const childFile = join(directory, readdirSync(directory).find((file) => file !== 'source.jsonl')!)
  const sourceBytes = readFileSync(sessionFile)
  expect(readPiSessionHistory({ sessionFile: childFile, expectedSessionId: result.session.id, expectedCwd: directory }).entries)
    .toEqual(readPiSessionHistory(binding).entries)
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

it('serves pinned native history, pagination and index over HTTP during generation', async () => {
  directory = mkdtempSync(join(tmpdir(), 'pi-nest-live-history-route-'))
  const timestamp = '2026-10-17T00:00:00Z'
  const session = { id: 'source', cwd: directory, sessionFile: join(directory, 'native.jsonl'), createdAt: timestamp, updatedAt: timestamp, firstMessage: 'first', name: undefined }
  const lines = [{ type: 'session', version: 3, id: session.id, cwd: directory, timestamp }, ...['first', 'second'].map((id, index) => ({ type: 'message', id, parentId: index ? 'first' : null, timestamp, message: { role: 'user', content: id, timestamp: Date.parse(timestamp) } }))]
  writeFileSync(session.sessionFile, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  vi.mocked(listPiSessions).mockResolvedValue([session])
  const history = new SessionHistorySnapshots()
  history.pin(session, 'live')
  const registry = { history, isPromptStreaming: () => true }
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
