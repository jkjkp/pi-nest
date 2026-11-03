import type Database from 'better-sqlite3'
import type { WorkspaceDatabase } from './workspace-database.js'
export type BranchRecord = {
  operation_id: string; request_hash: string; child_session_id: string; parent_session_id: string
  source_entry_id: string | null; inherited_leaf_id: string | null; inherited_hash: string
  fork_mode: 'edit' | 'continue' | 'clone'; source_revision: string; cwd: string; created_at: string
  state: 'pending' | 'ready' | 'failed' | 'attention'; error_code: string | null
}
export class SessionBranchStore {
  private failure?: string
  constructor(private readonly database?: WorkspaceDatabase) {}
  get health() { return this.failure ? { available: false, error: this.failure } : this.database?.health ?? { available: false, error: '关系数据库未配置' } }
  private query<T>(read: (db: Database.Database) => T): T {
    if (!this.health.available || !this.database?.connection) throw new Error('关系存储不可用，无法创建新分支。')
    try { return read(this.database.connection) }
    catch (cause) { this.failure = cause instanceof Error ? cause.message : '关系存储失败'; throw cause }
  }
  operation(id: string) { return this.query((db) => db.prepare('SELECT * FROM session_branches WHERE operation_id=?').get(id) as BranchRecord | undefined) }
  prepare(record: BranchRecord) {
    // Uniqueness errors belong to the request, not database health.
    if (!this.database?.connection || !this.health.available) throw new Error('关系存储不可用')
    try { this.database.connection.prepare(`INSERT INTO session_branches VALUES (@operation_id,@request_hash,@child_session_id,@parent_session_id,@source_entry_id,@inherited_leaf_id,@inherited_hash,@fork_mode,@source_revision,@cwd,@created_at,@state,@error_code)`).run(record) }
    catch (cause) {
      if (!(cause as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) this.failure = cause instanceof Error ? cause.message : '关系存储失败'
      throw cause
    }
  }
  setState(id: string, state: BranchRecord['state'], error: string | null = null) {
    this.query((db) => db.prepare('UPDATE session_branches SET state=?, error_code=? WHERE operation_id=?').run(state, error, id))
  }
  pending() { return this.query((db) => db.prepare("SELECT * FROM session_branches WHERE state='pending'").all() as BranchRecord[]) }
  relations() {
    if (!this.health.available) return new Map<string, BranchRecord>()
    try { return new Map(this.query((db) => db.prepare("SELECT * FROM session_branches WHERE state IN ('ready','pending','attention')").all() as BranchRecord[]).map((row) => [row.child_session_id, row])) }
    catch { return new Map<string, BranchRecord>() }
  }
}
