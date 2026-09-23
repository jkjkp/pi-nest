import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ExtensionUiProjectionData = { statuses: Record<string, string>; widgets: Record<string, string[]> }

const maxBytes = 64 * 1024
const maxAgeMs = 30 * 24 * 60 * 60_000
const schemaVersion = 1

function fileName(sessionId: string) {
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function projection(value: unknown): ExtensionUiProjectionData | undefined {
  if (!isRecord(value) || !isRecord(value.statuses) || !isRecord(value.widgets)) return undefined
  const statuses = Object.entries(value.statuses)
  const widgets = Object.entries(value.widgets)
  if (!statuses.every(([key, status]) => key.length > 0 && typeof status === 'string')) return undefined
  if (!widgets.every(([key, lines]) => key.length > 0 && Array.isArray(lines) && lines.every((line) => typeof line === 'string'))) return undefined
  return {
    statuses: Object.fromEntries(statuses.map(([key, status]) => [key, status as string])),
    widgets: Object.fromEntries(widgets.map(([key, lines]) => [key, [...(lines as string[])] ])),
  }
}

export type ProjectionSidecarStoreOptions = {
  directory?: string
  now?: () => number
}

/** Durable Pi Nest-only last-value projection cache; never a Pi session source. */
export class ProjectionSidecarStore {
  readonly directory: string
  private readonly now: () => number
  private readonly restored: Promise<Map<string, ExtensionUiProjectionData>>

  constructor(options: ProjectionSidecarStoreOptions = {}) {
    this.directory = options.directory ?? process.env.PI_NEST_PROJECTION_DIR ?? join(homedir(), '.pi-nest', 'projections')
    this.now = options.now ?? Date.now
    this.restored = this.load()
  }

  async loadAll() {
    return new Map(await this.restored)
  }

  async save(sessionId: string, value: ExtensionUiProjectionData) {
    const payload = JSON.stringify({ projection: value, savedAt: this.now(), schemaVersion, sessionId })
    if (Buffer.byteLength(payload) > maxBytes) {
      await this.delete(sessionId)
      return false
    }
    let temporary: string | undefined
    try {
      await this.ensureDirectory()
      const target = this.pathFor(sessionId)
      temporary = join(this.directory, `.${randomUUID()}.tmp`)
      const handle = await open(temporary, 'w', 0o600)
      try {
        await handle.chmod(0o600)
        await handle.writeFile(payload)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
      return true
    } catch {
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
      return false
    }
  }

  async delete(sessionId: string) {
    try {
      await rm(this.pathFor(sessionId), { force: true })
      return true
    } catch {
      return false
    }
  }

  private async load() {
    try {
      await this.ensureDirectory()
      const files = await readdir(this.directory)
      const restored = new Map<string, ExtensionUiProjectionData>()
      await Promise.all(files.filter((name) => name.endsWith('.json')).map(async (name) => {
        const path = join(this.directory, name)
        try {
          const raw = await readFile(path)
          if (raw.byteLength > maxBytes) throw new Error('sidecar is too large')
          const value = JSON.parse(raw.toString('utf8')) as unknown
          if (!isRecord(value) || value.schemaVersion !== schemaVersion || typeof value.sessionId !== 'string' || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || value.savedAt > this.now() || this.now() - value.savedAt > maxAgeMs || name !== fileName(value.sessionId)) throw new Error('sidecar is invalid')
          const saved = projection(value.projection)
          if (!saved) throw new Error('sidecar projection is invalid')
          restored.set(value.sessionId, saved)
        } catch {
          await rm(path, { force: true }).catch(() => undefined)
        }
      }))
      return restored
    } catch {
      return new Map<string, ExtensionUiProjectionData>()
    }
  }

  private pathFor(sessionId: string) {
    return join(this.directory, fileName(sessionId))
  }

  private async ensureDirectory() {
    await mkdir(this.directory, { mode: 0o700, recursive: true })
    await chmod(this.directory, 0o700)
  }
}
