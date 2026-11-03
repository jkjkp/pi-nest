import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { WorkspaceDatabase } from './workspace-database.js'
const directory = mkdtempSync(join(tmpdir(), 'pi-nest-db-'))
afterEach(() => rmSync(directory, { recursive: true, force: true }))
it('initializes, persists and reopens v1 without touching other data', () => {
  const path = join(directory, 'data', 'workspace.sqlite')
  const db = new WorkspaceDatabase(path)
  expect(db.health.available).toBe(true)
  expect(db.connection!.pragma('user_version', { simple: true })).toBe(1)
  expect(db.connection!.pragma('journal_mode', { simple: true })).toBe('wal')
  db.connection!.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('saved')")
  db.close()
  const reopened = new WorkspaceDatabase(path)
  expect(reopened.connection!.prepare('SELECT value FROM proof').get()).toEqual({ value: 'saved' })
  reopened.close()
})
it('rolls back transactions and rejects unknown newer schemas without deleting data', () => {
  const path = join(directory, 'new.sqlite')
  const db = new WorkspaceDatabase(path)
  expect(() => db.connection!.transaction(() => { db.connection!.exec('CREATE TABLE rollback_test(id)'); throw new Error('stop') })()).toThrow('stop')
  expect(db.connection!.prepare("SELECT name FROM sqlite_master WHERE name='rollback_test'").get()).toBeUndefined()
  db.connection!.pragma('user_version = 999'); db.close()
  const unavailable = new WorkspaceDatabase(path)
  expect(unavailable.health.available).toBe(false)
  expect(unavailable.connection).toBeUndefined()
})
it('degrades on invalid databases and paths without replacing the file', () => {
  const path = join(directory, 'bad.sqlite')
  new WorkspaceDatabase(join(directory, 'ensure.sqlite')).close()
  writeFileSync(path, 'not a database')
  const db = new WorkspaceDatabase(path)
  expect(db.health.available).toBe(false)
  expect(new WorkspaceDatabase(join(path, 'child.sqlite')).health.available).toBe(false)
})
it('bounds a competing writer and reports the locked database without modifying it', async () => {
  const { SessionBranchStore } = await import('./session-branch-store.js')
  const path = join(directory, 'locked.sqlite')
  const first = new WorkspaceDatabase(path); const second = new WorkspaceDatabase(path)
  const store = new SessionBranchStore(second)
  try {
    first.connection!.exec('BEGIN IMMEDIATE')
    expect(() => store.prepare({ operation_id: 'op', request_hash: 'r', child_session_id: 'child', parent_session_id: 'parent', source_entry_id: null, inherited_leaf_id: null, inherited_hash: 'h', fork_mode: 'clone', source_revision: 'r', cwd: '/work', created_at: '', state: 'pending', error_code: null })).toThrow(/locked/)
    expect(store.health.available).toBe(false)
    first.connection!.exec('ROLLBACK')
    expect(first.connection!.prepare('SELECT count(*) AS total FROM session_branches').get()).toEqual({ total: 0 })
  } finally { first.close(); second.close() }
})
