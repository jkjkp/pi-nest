import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { resolve } from 'node:path'
import { diffLines } from 'diff'
import type { PiFileChange } from '@pi-nest/contracts'

type Snapshot = { text: string; exists: boolean } | { reason: 'binary' | 'too_large' | 'unreadable' | 'unrecorded' }
const maxFileBytes = 1024 * 1024
const maxBaselineBytes = 16 * maxFileBytes

function snapshot(path: string): Snapshot {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) return { reason: 'unreadable' }
    if (stat.size > maxFileBytes) return { reason: 'too_large' }
    const buffer = Buffer.alloc(maxFileBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const count = readSync(descriptor, buffer, size, buffer.length - size, null)
      if (!count) break
      size += count
    }
    if (size > maxFileBytes) return { reason: 'too_large' }
    const bytes = buffer.subarray(0, size)
    if (bytes.includes(0)) return { reason: 'binary' }
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), exists: true } }
    catch { return { reason: 'binary' } }
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT' ? { text: '', exists: false } : { reason: 'unreadable' }
  } finally { if (descriptor !== undefined) closeSync(descriptor) }
}

/** Content stays in memory; only bounded, per-file counts enter native tool results. */
export class FileChangeTracker {
  private readonly baselines = new Map<string, Snapshot>()
  private baselineBytes = 0
  private sequence = 0
  private readonly observed = new Set<string>()

  reset() { this.baselines.clear(); this.observed.clear(); this.baselineBytes = 0; this.sequence = 0 }

  before(cwd: string, path: string) {
    const absolute = resolve(cwd, path)
    if (!this.baselines.has(absolute) && this.baselines.size < 256) {
      let before = snapshot(absolute)
      if ('text' in before) {
        const size = Buffer.byteLength(before.text)
        if (this.baselineBytes + size > maxBaselineBytes) before = { reason: 'too_large' }
        else this.baselineBytes += size
      }
      this.baselines.set(absolute, before)
    }
    return absolute
  }

  invalidate(path: string) { this.baselines.set(path, { reason: 'unrecorded' }) }

  record(path: string, successful: boolean): PiFileChange {
    const change = this.after(path)
    if (successful || 'changeType' in change && change.changeType !== 'unchanged') this.observed.add(path)
    return change
  }

  finish() {
    return [...new Set([...this.baselines.keys(), ...this.observed])].map((path) => this.after(path))
      .filter((change) => this.observed.has(change.path) || 'changeType' in change && change.changeType !== 'unchanged')
  }

  after(path: string): PiFileChange {
    const base = { version: 1 as const, path, sequence: ++this.sequence }
    const before = this.baselines.get(path)
    if (!before) return { ...base, reason: 'unrecorded' }
    if ('reason' in before) return { ...base, reason: before.reason }
    const after = snapshot(path)
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
