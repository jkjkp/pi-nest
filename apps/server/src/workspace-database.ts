import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export class WorkspaceDatabase {
  connection?: Database.Database
  health: { available: boolean; error?: string } = { available: false }
  constructor(readonly path: string) {
    let db: Database.Database | undefined
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      db = new Database(path, { timeout: 1000 })
      if (path !== ':memory:') chmodSync(path, 0o600)
      const version = db.pragma('user_version', { simple: true }) as number
      if (version > 1) throw new Error('数据库版本高于当前程序支持的版本')
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = FULL')
      if (version === 0) db.transaction(() => {
        db!.exec(`CREATE TABLE session_branches (
          operation_id TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          child_session_id TEXT NOT NULL UNIQUE,
          parent_session_id TEXT NOT NULL,
          source_entry_id TEXT,
          inherited_leaf_id TEXT,
          inherited_hash TEXT NOT NULL,
          fork_mode TEXT NOT NULL CHECK(fork_mode IN ('edit','continue','clone')),
          source_revision TEXT NOT NULL,
          cwd TEXT NOT NULL,
          created_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','ready','failed','attention')),
          error_code TEXT,
          CHECK(child_session_id != parent_session_id)
        );
        CREATE INDEX branch_parent ON session_branches(parent_session_id);
        CREATE INDEX branch_state ON session_branches(state);
        PRAGMA user_version = 1;`)
      })()
      this.connection = db
      this.health = { available: true }
    } catch (cause) {
      db?.close()
      this.health = { available: false, error: cause instanceof Error ? cause.message : '关系数据库无法打开' }
    }
  }
  close() { this.connection?.close(); this.connection = undefined; this.health = { available: false, error: '关系数据库已关闭' } }
}
