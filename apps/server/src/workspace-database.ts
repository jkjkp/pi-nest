import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

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
      if (version > 3) throw new Error('数据库版本高于当前程序支持的版本')
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = FULL')
      db.pragma('foreign_keys = ON')
      if (version > 0 && version < 3 && path !== ':memory:') {
        const backup = `${path}.v${version}.${randomUUID()}.backup`
        db.prepare('VACUUM INTO ?').run(backup)
        chmodSync(backup, 0o600)
      }
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
      if (version < 2) db.transaction(() => {
        db!.exec(`CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          removed_at TEXT
        );
        CREATE TABLE project_sessions (
          session_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT
        );
        CREATE INDEX project_sessions_project ON project_sessions(project_id);
        CREATE TABLE workspace_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        PRAGMA user_version = 2;`)
      })()
      if (version < 3) db.transaction(() => {
        db!.exec(`ALTER TABLE projects ADD COLUMN directory_resolved INTEGER NOT NULL DEFAULT 1 CHECK(directory_resolved IN (0,1));
        ALTER TABLE project_sessions ADD COLUMN cwd TEXT;
        CREATE INDEX project_sessions_cwd ON project_sessions(cwd);
        PRAGMA user_version = 3;`)
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
