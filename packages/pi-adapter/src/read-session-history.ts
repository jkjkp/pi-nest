import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent'

export type PiSessionHistoryEntry = {
  id: string
  parentId: string | null
  raw: Record<string, unknown>
  timestamp: string
  type: string
}

export type PiSessionHistory = {
  beforeCursor?: string
  entries: PiSessionHistoryEntry[]
  hasEarlier: boolean
}

export type PiSessionHistoryOptions = {
  before?: string
  expectedCwd?: string
  expectedSessionId: string
  limit?: number
  sessionFile: string
}

export type PiSessionTurnIndexEntry = {
  id: string
  index: number
  promptPreview: string
  startedAt: string
}

export type PiSessionTurnIndex = { entries: PiSessionTurnIndexEntry[] }

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

function fingerprint(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
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

function withContextEntries<T>({ expectedCwd, expectedSessionId, sessionFile }: PiSessionTurnIndexOptions, read: (entries: SessionEntry[]) => T): T {
  let temporaryDirectory: string | undefined

  try {
    const hashBefore = fingerprint(sessionFile)
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'pi-nest-history-'))
    chmodSync(temporaryDirectory, 0o700)
    const temporarySessionFile = join(temporaryDirectory, 'session.jsonl')
    copyFileSync(sessionFile, temporarySessionFile)
    chmodSync(temporarySessionFile, 0o600)

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

    const contextEntries = session.buildContextEntries()
    if (hashBefore !== fingerprint(sessionFile)) throw new PiSessionHistorySourceChangedError()
    return read(contextEntries)
  } catch (cause) {
    if (cause instanceof PiSessionHistorySourceChangedError || cause instanceof PiSessionHistoryCursorError) throw cause
    throw new Error('Failed to read Pi session history', { cause })
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}

export function readPiSessionHistory({
  before,
  expectedCwd,
  expectedSessionId,
  limit = defaultPiSessionHistoryTurnLimit,
  sessionFile,
}: PiSessionHistoryOptions): PiSessionHistory {
  return withContextEntries({ expectedCwd, expectedSessionId, sessionFile }, (contextEntries) => {
    const contextTurns = turns(contextEntries)
    const end = before === undefined ? contextTurns.length : contextTurns.findIndex((turn) => turnStartId(turn[0]!) === before)
    if (end < 0) throw new PiSessionHistoryCursorError()
    const start = Math.max(0, end - limit)
    const page = contextTurns.slice(start, end)

    return {
      ...(start > 0 ? { beforeCursor: turnStartId(page[0]![0]!) } : {}),
      entries: page.flat().map(mapEntry),
      hasEarlier: start > 0,
    }
  })
}

export function readPiSessionTurnIndex(options: PiSessionTurnIndexOptions): PiSessionTurnIndex {
  return withContextEntries(options, (entries) => ({
    entries: turns(entries).map((turn, index) => {
      const entry = turn[0]!
      const startedAt = (entry as unknown as Record<string, unknown>).timestamp
      if (typeof startedAt !== 'string') throw new Error('Pi SDK returned an invalid native session entry')
      return { id: turnStartId(entry), index: index + 1, promptPreview: promptPreview(entry), startedAt }
    }),
  }))
}
