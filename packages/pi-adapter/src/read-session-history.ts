import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent'

const HISTORY_LIMIT = 200

export type PiSessionHistoryEntry = {
  id: string
  parentId: string | null
  raw: Record<string, unknown>
  timestamp: string
  type: string
}

export type PiSessionHistory = {
  entries: PiSessionHistoryEntry[]
  hasEarlier: boolean
}

export type PiSessionHistoryOptions = {
  expectedCwd?: string
  expectedSessionId: string
  sessionFile: string
}

export class PiSessionHistorySourceChangedError extends Error {
  constructor() {
    super('Pi native session changed while reading history')
    this.name = 'PiSessionHistorySourceChangedError'
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

export function readPiSessionHistory({
  expectedCwd,
  expectedSessionId,
  sessionFile,
}: PiSessionHistoryOptions): PiSessionHistory {
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
    const selectedEntries = contextEntries.slice(-HISTORY_LIMIT)
    const hashAfter = fingerprint(sessionFile)
    if (hashBefore !== hashAfter) throw new PiSessionHistorySourceChangedError()

    return {
      entries: selectedEntries.map(mapEntry),
      hasEarlier: contextEntries.length > HISTORY_LIMIT,
    }
  } catch (cause) {
    if (cause instanceof PiSessionHistorySourceChangedError) throw cause
    throw new Error('Failed to read Pi session history', { cause })
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}
