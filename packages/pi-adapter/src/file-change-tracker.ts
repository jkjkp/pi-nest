import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { diffLines } from 'diff'
import type { PiFileChange } from '@pi-nest/contracts'

type Snapshot = { text: string; exists: boolean } | { reason: 'binary' | 'too_large' | 'unreadable' | 'unrecorded' }
const maxFileBytes = 1024 * 1024
const maxBaselineBytes = 16 * maxFileBytes
const maxFiles = 4096
// shortcut: Bounded workspace scans omit dependencies and external script writes; expand scope only with explicit tracking.
const excludedDirectories = new Set(['.git', 'node_modules', '.venv'])
type WorkspaceFile = { signature: string; size: number }

function scanWorkspace(root: string, sessionFile?: string) {
  const files = new Map<string, WorkspaceFile>()
  const directories = [root]
  const deadline = Date.now() + 250
  let incomplete = false
  let visited = 0
  while (directories.length) {
    if (Date.now() > deadline || visited >= maxFiles) { incomplete = true; break }
    let directory: ReturnType<typeof opendirSync> | undefined
    try {
      directory = opendirSync(directories.pop()!)
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (++visited > maxFiles || Date.now() > deadline) { incomplete = true; break }
        const path = join(directory.path, entry.name)
        if (path === sessionFile || excludedDirectories.has(entry.name) || entry.isSymbolicLink()) continue
        if (entry.isDirectory()) { directories.push(path); continue }
        if (!entry.isFile()) continue
        try {
          const stat = lstatSync(path, { bigint: true })
          if (stat.isFile()) files.set(path, { signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`, size: Number(stat.size) })
        } catch { incomplete = true }
      }
    } catch { incomplete = true }
    finally { try { directory?.closeSync() } catch { incomplete = true } }
  }
  return { files, incomplete }
}

function snapshot(path: string): Snapshot {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) return { reason: 'unreadable' }
    if (stat.size > maxFileBytes) return { reason: 'too_large' }
    const buffer = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < buffer.length) {
      const count = readSync(descriptor, buffer, size, buffer.length - size, null)
      if (!count) break
      size += count
    }
    if (size > maxFileBytes) return { reason: 'too_large' }
    if (size > stat.size) return { reason: 'unreadable' }
    const bytes = buffer.subarray(0, size)
    if (bytes.includes(0)) return { reason: 'binary' }
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), exists: true } }
    catch { return { reason: 'binary' } }
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT' ? { text: '', exists: false } : { reason: 'unreadable' }
  } finally { if (descriptor !== undefined) closeSync(descriptor) }
}

/** Content stays in memory; only bounded, per-file counts enter native history. */
export class FileChangeTracker {
  private readonly baselines = new Map<string, Snapshot>()
  private baselineBytes = 0
  private sequence = 0
  private readonly observed = new Set<string>()
  private workspace?: { root: string; sessionFile?: string; files: Map<string, WorkspaceFile>; incomplete: boolean }
  incomplete = false

  reset() { this.baselines.clear(); this.observed.clear(); this.baselineBytes = 0; this.sequence = 0; this.workspace = undefined; this.incomplete = false }

  beforeWorkspace(cwd: string, sessionFile?: string) {
    if (this.workspace) return
    const root = resolve(cwd)
    const scan = scanWorkspace(root, sessionFile)
    this.workspace = { root, sessionFile, ...scan }
    this.incomplete ||= scan.incomplete
    const deadline = Date.now() + 250
    for (const [path, metadata] of scan.files) {
      if (this.baselines.has(path)) continue
      if (Date.now() > deadline) {
        this.baselines.set(path, { reason: 'unrecorded' })
        this.incomplete = true
      } else if (this.baselineBytes + metadata.size > maxBaselineBytes) {
        this.baselines.set(path, { reason: 'too_large' })
        this.incomplete = true
      } else this.before(root, path)
    }
  }

  before(cwd: string, path: string) {
    const absolute = resolve(cwd, path)
    if (!this.baselines.has(absolute) && this.baselines.size < maxFiles) {
      let before = snapshot(absolute)
      if ('reason' in before && before.reason === 'unreadable') this.incomplete = true
      if ('text' in before) {
        const size = Buffer.byteLength(before.text)
        if (this.baselineBytes + size > maxBaselineBytes) { before = { reason: 'too_large' }; this.incomplete = true }
        else this.baselineBytes += size
      }
      this.baselines.set(absolute, before)
    } else if (!this.baselines.has(absolute)) this.incomplete = true
    return absolute
  }

  invalidate(path: string) { this.baselines.set(path, { reason: 'unrecorded' }) }

  record(path: string, successful: boolean): PiFileChange {
    const change = this.after(path)
    if (successful || 'changeType' in change && change.changeType !== 'unchanged') this.observed.add(path)
    return change
  }

  finish() {
    const changed = new Set<string>()
    if (this.workspace) {
      const after = scanWorkspace(this.workspace.root, this.workspace.sessionFile)
      this.incomplete ||= after.incomplete
      for (const path of new Set([...this.workspace.files.keys(), ...after.files.keys()])) {
        if (this.workspace.files.get(path)?.signature === after.files.get(path)?.signature) continue
        // An incomplete traversal cannot prove deletion or that an existing file is new.
        if (!after.files.has(path) && after.incomplete) continue
        if (!this.workspace.files.has(path) && !this.baselines.has(path)) {
          if (this.workspace.incomplete) continue
          this.baselines.set(path, { text: '', exists: false })
        }
        changed.add(path)
      }
    }
    const direct = [...this.baselines.keys()].filter((path) => !this.workspace?.files.has(path))
    const deadline = Date.now() + 500
    return [...new Set([...direct, ...changed, ...this.observed])].map((path): PiFileChange => {
      if (Date.now() <= deadline) return this.after(path)
      this.incomplete = true
      return { version: 1, path, sequence: ++this.sequence, reason: 'diff_limit' }
    })
      .filter((change) => this.observed.has(change.path) || ('changeType' in change ? change.changeType !== 'unchanged' : changed.has(change.path)))
  }

  after(path: string): PiFileChange {
    const base = { version: 1 as const, path, sequence: ++this.sequence }
    const before = this.baselines.get(path)
    if (!before) return { ...base, reason: 'unrecorded' }
    if ('reason' in before) return { ...base, reason: before.reason }
    const after = snapshot(path)
    if ('reason' in after && after.reason === 'unreadable') this.incomplete = true
    if ('reason' in after) return { ...base, reason: after.reason }
    const oldText = before.text.replace(/\r\n/g, '\n')
    const newText = after.text.replace(/\r\n/g, '\n')
    // shortcut: Bound snapshot memory and diff time; raise limits if large-file statistics become necessary.
    const diff = diffLines(oldText, newText, { timeout: 100 })
    if (!diff) return { ...base, reason: 'diff_limit' }
    return { ...base, changeType: !before.exists && after.exists ? 'created' : before.exists && !after.exists ? 'deleted' : oldText === newText ? 'unchanged' : 'modified',
      added: diff.reduce((count, part) => count + (part.added ? part.count : 0), 0),
      removed: diff.reduce((count, part) => count + (part.removed ? part.count : 0), 0) }
  }
}
