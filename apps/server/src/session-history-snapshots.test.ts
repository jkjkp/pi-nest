import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capturePiSessionHistory } from '@pi-nest/pi-adapter'

vi.mock('@pi-nest/pi-adapter', async (original) => {
  const actual = await original<typeof import('@pi-nest/pi-adapter')>()
  return { ...actual, capturePiSessionHistory: vi.fn(actual.capturePiSessionHistory) }
})

import { HistorySnapshotExpired, SessionHistorySnapshots } from './session-history-snapshots.js'

let directory: string
let session: { id: string; cwd: string; sessionFile: string }
const time = '2026-10-17T00:00:00Z'
beforeEach(() => {
  vi.mocked(capturePiSessionHistory).mockClear()
  directory = mkdtempSync(join(tmpdir(), 'pi-snapshot-test-'))
  session = { id: 'source', cwd: directory, sessionFile: join(directory, 'source.jsonl') }
  writeFileSync(session.sessionFile, JSON.stringify({ type: 'session', version: 3, id: session.id, cwd: directory, timestamp: time }) + '\n')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
function user(id: string, parentId: string | null) { appendFileSync(session.sessionFile, JSON.stringify({ type: 'message', id, parentId, timestamp: time, message: { role: 'user', content: id, timestamp: Date.parse(time) } }) + '\n') }

it('serves all pages and previews from a pinned version while native entries are appended', () => {
  user('a', null); user('b', 'a'); user('c', 'b')
  const store = new SessionHistorySnapshots()
  store.pin(session, 'run')
  const latest = store.history(session, { limit: 1 })
  user('d', 'c')
  expect(store.history(session).entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  expect(store.index(session, latest.revision).entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  expect(store.history(session, { revision: latest.revision, before: latest.beforeCursor, limit: 1 }).entries[0]?.id).toBe('b')
  store.unpin(session, 'run')
  const complete = store.history(session)
  expect(complete.entries.at(-1)).toMatchObject({ id: 'd', runId: 'run', runIndex: 0 })
  expect(store.history(session, { revision: latest.revision }).entries).toHaveLength(3)
})
it('ignores an incomplete tail without modifying the source and rejects malformed complete frames', () => {
  user('a', null)
  appendFileSync(session.sessionFile, '{"type":')
  const bytes = readFileSync(session.sessionFile)
  const store = new SessionHistorySnapshots()
  expect(store.history(session).entries[0]?.id).toBe('a')
  expect(readFileSync(session.sessionFile)).toEqual(bytes)
  appendFileSync(session.sessionFile, '\n')
  expect(() => store.history(session)).toThrow('Failed to read Pi session history')
})
it('evicts only unpinned versions and reports an expired snapshot explicitly', () => {
  user('a', null)
  const store = new SessionHistorySnapshots(1024 * 1024, 2)
  store.pin(session, 'run')
  const a = store.history(session).revision
  user('b', 'a'); store.unpin(session, 'run')
  const b = store.history(session).revision
  user('c', 'b'); store.history(session)
  expect(() => store.history(session, { revision: a })).toThrow(HistorySnapshotExpired)
  expect(store.history(session, { revision: b }).entries).toHaveLength(2)
})
it('never lets a snapshot token access another session', () => {
  user('a', null)
  const store = new SessionHistorySnapshots()
  const revision = store.history(session).revision
  expect(() => store.history({ ...session, id: 'wrong' }, { revision })).toThrow()
})
it('keeps repeated prompts and steering identities distinct across consecutive runs', () => {
  user('old', null)
  const store = new SessionHistorySnapshots()
  store.pin(session, 'first')
  user('u1', 'old'); user('steering', 'u1')
  store.unpin(session, 'first')
  store.pin(session, 'second')
  user('u2', 'steering')
  store.unpin(session, 'second')
  expect(store.history(session).entries.slice(1).map(({ id, runId, runIndex }) => ({ id, runId, runIndex }))).toEqual([
    { id: 'u1', runId: 'first', runIndex: 0 },
    { id: 'steering', runId: 'first', runIndex: 1 },
    { id: 'u2', runId: 'second', runIndex: 0 },
  ])
})
it('does not evict the active snapshot to make room for another session', () => {
  user('a', null)
  const store = new SessionHistorySnapshots(1024 * 1024, 1)
  store.pin(session, 'run')
  const other = { ...session, id: 'other', sessionFile: join(directory, 'other.jsonl') }
  writeFileSync(other.sessionFile, JSON.stringify({ type: 'session', version: 3, id: other.id, cwd: directory, timestamp: time }) + '\n')
  expect(() => store.pin(other, 'other-run')).toThrow('capacity')
  user('b', 'a')
  expect(store.history(session).entries.map((entry) => entry.id)).toEqual(['a'])
})

it('preserves run identity when the new version replaces the only retained version', () => {
  user('old', null)
  const store = new SessionHistorySnapshots(1024 * 1024, 1)
  store.pin(session, 'first'); user('first-user', 'old'); store.unpin(session, 'first')
  store.pin(session, 'second'); user('second-user', 'first-user'); store.unpin(session, 'second')
  expect(store.history(session).entries.slice(1).map((entry) => entry.runId)).toEqual(['first', 'second'])
})

it('captures unchanged idle history only once across pages and indexes', () => {
  user('a', null); user('b', 'a')
  const store = new SessionHistorySnapshots()
  const page = store.history(session, { limit: 1 })
  store.history(session, { before: page.beforeCursor })
  store.index(session)
  expect(capturePiSessionHistory).toHaveBeenCalledTimes(1)
  expect(() => JSON.stringify(store.history(session))).not.toThrow()
})

it('refreshes after same-size rewrites with restored mtime, replacement and truncation', () => {
  user('a', null)
  const store = new SessionHistorySnapshots()
  const first = store.history(session)
  const signature = statSync(session.sessionFile)
  const original = readFileSync(session.sessionFile, 'utf8')
  writeFileSync(session.sessionFile, original.replace('"content":"a"', '"content":"z"'))
  utimesSync(session.sessionFile, signature.atime, signature.mtime)
  expect(store.history(session).revision).not.toBe(first.revision)
  const replacement = join(directory, 'replacement.jsonl')
  writeFileSync(replacement, original)
  renameSync(replacement, session.sessionFile)
  expect(store.history(session).revision).toBe(first.revision)
  truncateSync(session.sessionFile, original.indexOf('\n') + 1)
  expect(store.history(session).entries).toEqual([])
  expect(capturePiSessionHistory).toHaveBeenCalledTimes(4)
  rmSync(session.sessionFile)
  expect(() => store.history(session)).toThrow()
  expect(store.history(session, { revision: first.revision }).entries).toHaveLength(1)
})

it('updates the signature when incomplete tails keep the same revision and invalidates on clear', () => {
  user('a', null)
  const store = new SessionHistorySnapshots()
  const first = store.history(session)
  appendFileSync(session.sessionFile, '{"type":')
  expect(store.history(session).revision).toBe(first.revision)
  store.index(session)
  expect(capturePiSessionHistory).toHaveBeenCalledTimes(2)
  store.clear()
  store.history(session)
  expect(capturePiSessionHistory).toHaveBeenCalledTimes(3)
})

it('recaptures evicted latest versions and keeps latest cache hits recently used', () => {
  user('a', null)
  const store = new SessionHistorySnapshots(1024 * 1024, 2)
  const other = { ...session, sessionFile: join(directory, 'other.jsonl') }
  writeFileSync(other.sessionFile, readFileSync(session.sessionFile))
  store.history(session); store.history(other); store.index(session)
  user('b', 'a'); store.history(session)
  store.history(other)
  expect(capturePiSessionHistory).toHaveBeenCalledTimes(4)
})

it('does not reuse an uncertified capture as the latest snapshot', () => {
  user('a', null)
  const store = new SessionHistorySnapshots()
  const actual = capturePiSessionHistory({ sessionFile: session.sessionFile, expectedSessionId: session.id })
  const { sourceSignature: _signature, ...uncertified } = actual
  vi.mocked(capturePiSessionHistory).mockReturnValueOnce(uncertified).mockClear()
  store.history(session); store.index(session); store.history(session)
  expect(capturePiSessionHistory).toHaveBeenCalledTimes(2)
})

it('recaptures a valid final frame once its newline is appended', () => {
  user('a', null)
  const store = new SessionHistorySnapshots()
  const original = readFileSync(session.sessionFile)
  user('b', 'a')
  truncateSync(session.sessionFile, statSync(session.sessionFile).size - 1)
  expect(store.history(session).entries).toHaveLength(1)
  appendFileSync(session.sessionFile, '\n')
  expect(store.history(session).entries).toHaveLength(2)
  expect(readFileSync(session.sessionFile).subarray(0, original.length)).toEqual(original)
})
