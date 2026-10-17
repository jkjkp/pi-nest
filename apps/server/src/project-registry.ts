import { accessSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PiProject } from '@pi-nest/contracts'

const projectsSchema = z.array(z.object({ cwd: z.string().min(1), createdAt: z.string().datetime() }).strict())

export function resolveProjectDirectory(cwd: string) {
  if (!isAbsolute(cwd)) throw new Error('请输入文件夹的绝对路径。')
  const canonical = realpathSync(cwd)
  if (!statSync(canonical).isDirectory()) throw new Error('该路径不是文件夹。')
  accessSync(canonical, constants.R_OK | constants.X_OK)
  return canonical
}

export class ProjectRegistry {
  constructor(readonly path = join(homedir(), '.pi-nest', 'projects.json')) {}

  list(): PiProject[] {
    try { return projectsSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))) }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('项目登记文件无法读取，请检查文件格式和权限。', { cause })
    }
  }

  has(cwd: string) {
    return this.list().some((project) => project.cwd === cwd) && resolveProjectDirectory(cwd) === cwd
  }

  open(cwd: string): PiProject {
    const canonical = resolveProjectDirectory(cwd)
    const projects = this.list()
    const existing = projects.find((project) => project.cwd === canonical)
    if (existing) return existing
    const project = { cwd: canonical, createdAt: new Date().toISOString() }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify([...projects, project], null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path)
    } finally { rmSync(temporary, { force: true }) }
    return project
  }

  create(parent: string, name: string): PiProject {
    if (!name.trim() || name !== name.trim() || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('文件夹名称无效。')
    this.list()
    const path = join(resolveProjectDirectory(parent), name)
    mkdirSync(path)
    try { return this.open(path) }
    catch (cause) { throw new Error('文件夹已创建，但项目登记失败。请修复登记文件后使用“打开项目”添加。', { cause }) }
  }
}
