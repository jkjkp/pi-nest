import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import { listPiSessions, readPiSessionHistory, readPiSessionTurnIndex, renamePiSession } from '@pi-nest/pi-adapter'
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
