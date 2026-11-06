import { accessSync, constants, copyFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PiProject } from '@pi-nest/contracts'
import { WorkspaceDatabase } from './workspace-database.js'
import type { SessionIndex } from './session-index.js'

const projectsSchema = z.array(z.object({ cwd: z.string().min(1), createdAt: z.string().datetime() }).strict())
const columns = 'id, cwd, created_at AS createdAt, removed_at AS removedAt'
type SessionBinding = { id: string; cwd?: string; createdAt?: string }

export class ProjectStorageError extends Error {
  readonly code = 'PROJECT_STORAGE_UNAVAILABLE'
}

export function resolveProjectDirectory(cwd: string) {
  if (!isAbsolute(cwd)) throw new Error('请输入文件夹的绝对路径。')
  const canonical = realpathSync(cwd)
  if (!statSync(canonical).isDirectory()) throw new Error('该路径不是文件夹。')
  accessSync(canonical, constants.R_OK | constants.X_OK)
  return canonical
}

function projectPath(cwd: string) {
  if (!isAbsolute(cwd)) throw new Error('项目路径必须是绝对路径。')
  try { return { cwd: realpathSync(cwd), resolved: true } }
  catch (cause) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause
    return { cwd: normalize(cwd), resolved: false }
  }
}

export class ProjectRegistry {
  private migrationError?: string
  constructor(readonly database = new WorkspaceDatabase(':memory:'), legacyPath?: string) {
    if (!legacyPath || !database.health.available) return
    try {
      const db = this.db
      if (db.prepare('SELECT 1 FROM workspace_migrations WHERE name=?').get('projects-json')) return
      let source: string | undefined
      try { source = readFileSync(legacyPath, 'utf8') }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
      const legacy = source === undefined ? [] : projectsSchema.parse(JSON.parse(source))
      if (source !== undefined) {
        try { copyFileSync(legacyPath, `${legacyPath}.pre-sqlite.bak`, constants.COPYFILE_EXCL) }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
      }
      db.transaction(() => {
        for (const project of legacy) {
          const imported = this.remember(project.cwd, project.createdAt)
          // Legacy registration already resolved this physical directory, even if it is now offline.
          db.prepare('UPDATE projects SET directory_resolved=1 WHERE id=?').run(imported.id)
        }
        db.prepare('INSERT INTO workspace_migrations VALUES (?, ?)').run('projects-json', new Date().toISOString())
      })()
    } catch (cause) { this.migrationError = cause instanceof Error ? cause.message : '旧项目登记文件迁移失败。' }
  }

  get health() { return this.migrationError ? { available: false, error: this.migrationError } : this.database.health }
  private get db() {
    if (!this.health.available || !this.database.connection) throw new ProjectStorageError('项目数据库不可用，请检查数据库和旧项目登记文件。')
    return this.database.connection
  }
  list(state: 'active' | 'removed' = 'active'): PiProject[] {
    return this.db.prepare(`SELECT ${columns} FROM projects WHERE removed_at IS ${state === 'active' ? 'NULL' : 'NOT NULL'} ORDER BY created_at DESC, id`).all() as PiProject[]
  }
  find(cwd: string) {
    if (!isAbsolute(cwd)) throw new Error('项目路径必须是绝对路径。')
    const path = normalize(cwd)
    return (this.db.prepare(`SELECT ${columns} FROM projects WHERE cwd=?`).get(path)
      ?? this.db.prepare(`SELECT ${columns} FROM projects WHERE id=(SELECT project_id FROM project_sessions WHERE cwd=? LIMIT 1)`).get(path)
      ?? this.db.prepare(`SELECT ${columns} FROM projects WHERE cwd=?`).get(projectPath(path).cwd)) as PiProject | undefined
  }
  private remember(cwd: string, createdAt = new Date().toISOString()) {
    const path = projectPath(cwd)
    const existing = this.find(cwd)
    if (existing) {
      const binding = this.db.prepare('SELECT directory_resolved FROM projects WHERE id=?').get(existing.id) as { directory_resolved: number }
      if (!binding.directory_resolved && path.resolved) {
        this.db.prepare('UPDATE projects SET cwd=?, directory_resolved=1 WHERE id=?').run(path.cwd, existing.id)
        return { ...existing, cwd: path.cwd }
      }
      return existing
    }
    this.db.prepare('INSERT INTO projects (id,cwd,created_at,directory_resolved) VALUES (?,?,?,?) ON CONFLICT(cwd) DO NOTHING').run(randomUUID(), path.cwd, createdAt, Number(path.resolved))
    return this.find(path.cwd)!
  }
  has(cwd: string) {
    const project = this.find(cwd) && this.remember(cwd)
    return Boolean(project && !project.removedAt && resolveProjectDirectory(cwd) === project.cwd)
  }
  async authorize(cwd: string, sessions: SessionIndex) {
    if (!this.find(cwd)) this.sync(await sessions.list())
    return this.has(cwd)
  }
  sync(sessions: SessionBinding[]) {
    return this.db.transaction(() => {
      const ids = new Map<string, string>()
      const projects = new Map<string, PiProject>()
      for (const session of sessions) {
        if (!session.cwd) continue
        let project = projects.get(session.cwd)
        if (!project) {
          // v2 did not record native aliases; keep the old identity while its target is offline.
          const legacy = !this.find(session.cwd) && !projectPath(session.cwd).resolved
            ? this.db.prepare(`SELECT ${columns} FROM projects WHERE id=(SELECT project_id FROM project_sessions WHERE session_id=? AND cwd IS NULL)`).get(session.id) as PiProject | undefined
            : undefined
          project = legacy ?? this.remember(session.cwd, session.createdAt)
        }
        projects.set(session.cwd, project)
        this.link(session.id, project.id, session.cwd)
        ids.set(session.id, project.id)
      }
      return ids
    })()
  }
  private link(sessionId: string, projectId: string, cwd: string) {
    const path = normalize(cwd)
    const existing = this.db.prepare('SELECT project_id, cwd FROM project_sessions WHERE session_id=?').get(sessionId) as { project_id: string; cwd: string | null } | undefined
    if (existing && existing.project_id !== projectId) throw new Error('会话项目归属冲突，请检查原生会话文件。')
    if (!existing) this.db.prepare('INSERT INTO project_sessions (session_id,project_id,cwd) VALUES (?,?,?)').run(sessionId, projectId, path)
    else if (existing.cwd !== path) this.db.prepare('UPDATE project_sessions SET cwd=? WHERE session_id=?').run(path, sessionId)
  }
  registerSession(session: SessionBinding) {
    return this.db.transaction(() => {
      const project = session.cwd ? this.find(session.cwd) : undefined
      if (!project || project.removedAt) throw new Error('项目已移除或不存在，请先添加项目。')
      this.link(session.id, project.id, session.cwd!)
      return project.id
    })()
  }
  forgetSession(id: string) { this.db.prepare('DELETE FROM project_sessions WHERE session_id=?').run(id) }
  open(cwd: string): PiProject {
    const canonical = resolveProjectDirectory(cwd)
    return this.db.transaction(() => {
      const project = this.remember(cwd)
      this.db.prepare('UPDATE projects SET cwd=?, directory_resolved=1, removed_at=NULL WHERE id=?').run(canonical, project.id)
      return { ...project, cwd: canonical, removedAt: null }
    })()
  }
  create(parent: string, name: string): PiProject {
    if (!name.trim() || name !== name.trim() || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('文件夹名称无效。')
    this.list()
    const path = join(resolveProjectDirectory(parent), name)
    mkdirSync(path)
    try { return this.open(path) }
    catch (cause) { throw new ProjectStorageError('文件夹已创建，但项目登记失败。请修复数据库后使用“打开项目”添加。', { cause }) }
  }
  remove(id: string) { return this.db.prepare('UPDATE projects SET removed_at=COALESCE(removed_at,?) WHERE id=?').run(new Date().toISOString(), id).changes > 0 }
  restore(id: string) { return this.db.prepare('UPDATE projects SET removed_at=NULL WHERE id=?').run(id).changes > 0 }
  get legacyVisibilityPending() { return !this.db.prepare('SELECT 1 FROM workspace_migrations WHERE name=?').get('browser-project-visibility') }
  migrateVisibility(paths: string[]) {
    return this.db.transaction(() => {
      if (!this.legacyVisibilityPending) return
      for (const cwd of paths) this.remove(this.remember(cwd).id)
      this.db.prepare('INSERT INTO workspace_migrations VALUES (?,?)').run('browser-project-visibility', new Date().toISOString())
    })()
  }
}
