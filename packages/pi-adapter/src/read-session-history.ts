import type { PiSessionHistoryEntry, PiSessionHistory, PiSessionTurnIndexEntry, PiSessionTurnIndex } from '@pi-nest/contracts'
export type { PiSessionHistoryEntry, PiSessionHistory, PiSessionTurnIndexEntry, PiSessionTurnIndex } from '@pi-nest/contracts'

import { chmodSync, closeSync, fstatSync, openSync, readSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent'

export type PiSessionHistoryOptions = {
  before?: string
  expectedCwd?: string
  expectedSessionId: string
  limit?: number
  revision?: string
  sessionFile: string
}

export type PiSessionTurnIndexOptions = Omit<PiSessionHistoryOptions, 'before' | 'limit'>

export const defaultPiSessionHistoryTurnLimit = 40

export class PiSessionHistorySourceChangedError extends Error {
  constructor() {
    super('Pi native session changed while reading history')
    this.name = 'PiSessionHistorySourceChangedError'
  }
}

export class PiSessionHistoryCursorError extends Error {
  constructor() {
    super('Pi native session history cursor is invalid')
    this.name = 'PiSessionHistoryCursorError'
  }
}

export class PiSessionHistoryRevisionError extends Error {
  constructor() {
    super('Pi native session history revision is no longer current')
    this.name = 'PiSessionHistoryRevisionError'
  }
}

export type PiSessionHistorySnapshot = { revision: string; bytes: number; entries: SessionEntry[] }

function sourceBytes(file: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size
      const bytes = Buffer.alloc(size)
      let offset = 0
      while (offset < size) {
        const count = readSync(fd, bytes, offset, size - offset, offset)
        if (!count) break
        offset += count
      }
      const end = bytes.lastIndexOf(10, offset - 1) + 1
      if (!end) continue
      const complete = bytes.subarray(0, end)
      const verify = Buffer.alloc(end)
      if (readSync(fd, verify, 0, end, 0) !== end || !complete.equals(verify)) continue
      // Ignore only an unfinished final JSONL frame; malformed complete records are an error.
      for (const line of complete.toString('utf8').split('\n')) if (line.trim()) JSON.parse(line)
      return complete
    } finally { closeSync(fd) }
  }
  throw new PiSessionHistorySourceChangedError()
}

function mapEntry(entry: SessionEntry): PiSessionHistoryEntry {
  const raw = entry as unknown as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.timestamp !== 'string' || typeof raw.type !== 'string') {
    throw new Error('Pi SDK returned an invalid native session entry')
  }
  return {
    id: raw.id,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    raw,
    timestamp: raw.timestamp,
    type: raw.type,
  }
}

function turnStart(entry: SessionEntry) {
  const raw = entry as unknown as Record<string, unknown>
  const message = raw.message
  return raw.type === 'message' && message && typeof message === 'object' && !Array.isArray(message) && (message as Record<string, unknown>).role === 'user'
}

function turnStartId(entry: SessionEntry) {
  const id = (entry as unknown as Record<string, unknown>).id
  if (typeof id !== 'string') throw new Error('Pi SDK returned an invalid native session entry')
  return id
}

function turns(entries: SessionEntry[]) {
  const result: SessionEntry[][] = []
  let current: SessionEntry[] | undefined
  for (const entry of entries) {
    if (turnStart(entry)) {
      if (current) result.push(current)
      current = [entry]
    } else if (current) current.push(entry)
  }
  if (current) result.push(current)
  return result
}

function promptPreview(entry: SessionEntry) {
  const message = (entry as unknown as Record<string, unknown>).message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return '无用户正文'
  const content = (message as Record<string, unknown>).content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => typeof part === 'object' && part !== null && !Array.isArray(part) && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text : '').join('\n')
      : ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 160) || '无用户正文'
}

export function capturePiSessionHistory({ expectedCwd, expectedSessionId, sessionFile }: PiSessionTurnIndexOptions): PiSessionHistorySnapshot {
  let temporaryDirectory: string | undefined

  try {
    const bytes = sourceBytes(sessionFile)
    const revision = createHash('sha256').update(bytes).digest('hex')
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pi-nest-history-'))
    chmodSync(temporaryDirectory, 0o700)
    const temporarySessionFile = join(temporaryDirectory, 'session.jsonl')
    writeFileSync(temporarySessionFile, bytes, { flag: 'wx', mode: 0o600 })

    const session = SessionManager.open(temporarySessionFile)
    const header = session.getHeader()
    if (
      !header ||
      session.getSessionId() !== expectedSessionId ||
      session.getSessionFile() !== temporarySessionFile ||
      (expectedCwd !== undefined && header.cwd !== expectedCwd)
    ) {
      throw new Error('Pi SDK did not open the requested native session copy')
    }

    const branchEntries = session.getBranch()
    return { entries: branchEntries, revision, bytes: bytes.length }
  } catch (cause) {
    if (cause instanceof PiSessionHistoryRevisionError || cause instanceof PiSessionHistorySourceChangedError || cause instanceof PiSessionHistoryCursorError) throw cause
    throw new Error('Failed to read Pi session history', { cause })
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}

function withBranchEntries<T>(options: PiSessionTurnIndexOptions, read: (entries: SessionEntry[], revision: string) => T): T {
  const snapshot = capturePiSessionHistory(options)
  if (options.revision !== undefined && options.revision !== snapshot.revision) throw new PiSessionHistoryRevisionError()
  return read(snapshot.entries, snapshot.revision)
}

export function historyFromSnapshot(snapshot: PiSessionHistorySnapshot, { before, limit = defaultPiSessionHistoryTurnLimit }: Pick<PiSessionHistoryOptions, 'before' | 'limit'> = {}): PiSessionHistory {
  const branchTurns = turns(snapshot.entries)
  const end = before === undefined ? branchTurns.length : branchTurns.findIndex((turn) => turnStartId(turn[0]!) === before)
  if (end < 0) throw new PiSessionHistoryCursorError()
  const start = Math.max(0, end - limit)
  const page = branchTurns.slice(start, end)
  return { ...(start > 0 ? { beforeCursor: turnStartId(page[0]![0]!) } : {}), entries: page.flat().map(mapEntry), hasEarlier: start > 0, revision: snapshot.revision }
}

export function turnIndexFromSnapshot(snapshot: PiSessionHistorySnapshot): PiSessionTurnIndex {
  return { revision: snapshot.revision, entries: turns(snapshot.entries).map((turn, index) => {
    const entry = turn[0]!
    const startedAt = (entry as unknown as Record<string, unknown>).timestamp
    if (typeof startedAt !== 'string') throw new Error('Pi SDK returned an invalid native session entry')
    return { id: turnStartId(entry), index: index + 1, promptPreview: promptPreview(entry), startedAt }
  }) }
}

export function readPiSessionHistory(options: PiSessionHistoryOptions): PiSessionHistory {
  return withBranchEntries(options, (entries, revision) => historyFromSnapshot({ entries, revision, bytes: 0 }, options))
}

export function readPiSessionTurnIndex(options: PiSessionTurnIndexOptions): PiSessionTurnIndex {
  return withBranchEntries(options, (entries, revision) => turnIndexFromSnapshot({ entries, revision, bytes: 0 }))
}
