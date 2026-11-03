import { expect, it } from 'vitest'
import { WorkspaceDatabase } from './workspace-database.js'
import { SessionBranchStore, type BranchRecord } from './session-branch-store.js'
it('persists operation identity and immutable lineage across state changes', () => {
  const database = new WorkspaceDatabase(':memory:')
  const store = new SessionBranchStore(database)
  const record: BranchRecord = { operation_id: 'op', request_hash: 'request', child_session_id: 'child', parent_session_id: 'parent', source_entry_id: 'u', inherited_leaf_id: null, inherited_hash: 'hash', fork_mode: 'edit', source_revision: 'revision', cwd: '/work', created_at: new Date().toISOString(), state: 'pending', error_code: null }
  store.prepare(record)
  expect(store.operation('op')).toEqual(record)
  expect(() => store.prepare({ ...record, operation_id: 'different' })).toThrow()
  store.setState('op', 'ready')
  expect(store.relations().get('child')).toMatchObject({ state: 'ready', parent_session_id: 'parent' })
  expect(store.pending()).toEqual([])
  expect(store.operation('op')?.request_hash).toBe('request')
  database.close()
  expect(store.health.available).toBe(false)
  expect(() => store.prepare(record)).toThrow()
  expect(store.relations().size).toBe(0)
})
it('degrades on readonly writes without changing persisted rows', () => {
  const database = new WorkspaceDatabase(':memory:')
  const store = new SessionBranchStore(database)
  database.connection!.pragma('query_only=ON')
  const record: BranchRecord = { operation_id: 'readonly', request_hash: 'request', child_session_id: 'child', parent_session_id: 'parent', source_entry_id: null, inherited_leaf_id: null, inherited_hash: 'hash', fork_mode: 'clone', source_revision: 'r', cwd: '/work', created_at: '', state: 'pending', error_code: null }
  expect(() => store.prepare(record)).toThrow()
  expect(store.health.available).toBe(false)
  expect(database.connection!.prepare('SELECT count(*) AS total FROM session_branches').get()).toEqual({ total: 0 })
  database.close()
})
