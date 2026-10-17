import { afterEach, beforeEach, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistorySnapshotExpired, SessionHistorySnapshots } from './session-history-snapshots.js'

let directory: string
let session: { id: string; cwd: string; sessionFile: string }
const time = '2026-10-17T00:00:00Z'
beforeEach(() => {
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
