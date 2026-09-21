import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager, type SessionEntry, type SessionMessageEntry } from '@earendil-works/pi-coding-agent'

const HISTORY_LIMIT = 200

export type PiSessionHistoryMessage = {
  hasOmittedContent?: boolean
  id: string
  kind: 'message'
  role: 'assistant' | 'user'
  stopReason?: string
  text: string
  timestamp: string
}

export type PiSessionHistoryOmitted = {
  count: number
  kind: 'omitted'
  label: '未展示的原生事件'
  timestamp: string
}

export type PiSessionHistory = {
  entries: Array<PiSessionHistoryMessage | PiSessionHistoryOmitted>
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

function textContent(content: unknown) {
  if (typeof content === 'string') return { hasOmittedContent: false, text: content }
  if (!Array.isArray(content)) return undefined

  const text: string[] = []
  let hasOmittedContent = false
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
    ) {
      text.push(block.text)
    } else {
      hasOmittedContent = true
    }
  }

  return text.length > 0 ? { hasOmittedContent, text: text.join('') } : undefined
}

function omitted(timestamp: string): PiSessionHistoryOmitted {
  return { count: 1, kind: 'omitted', label: '未展示的原生事件', timestamp }
}

function mapMessage(entry: SessionMessageEntry): PiSessionHistoryMessage | PiSessionHistoryOmitted {
  const { message } = entry
  if (message.role !== 'user' && message.role !== 'assistant') return omitted(entry.timestamp)

  const content = textContent(message.content)
  if (!content) return omitted(entry.timestamp)

  return {
    ...(content.hasOmittedContent ? { hasOmittedContent: true } : {}),
    id: entry.id,
    kind: 'message',
    role: message.role,
    ...(message.role === 'assistant' ? { stopReason: message.stopReason } : {}),
    text: content.text,
    timestamp: entry.timestamp,
  }
}

function mapEntry(entry: SessionEntry): PiSessionHistoryMessage | PiSessionHistoryOmitted {
  return entry.type === 'message' ? mapMessage(entry) : omitted(entry.timestamp)
}

function groupOmitted(entries: Array<PiSessionHistoryMessage | PiSessionHistoryOmitted>) {
  return entries.reduce<Array<PiSessionHistoryMessage | PiSessionHistoryOmitted>>((grouped, entry) => {
    const previous = grouped.at(-1)
    if (entry.kind === 'omitted' && previous?.kind === 'omitted') {
      previous.count += entry.count
      return grouped
    }
    grouped.push(entry)
    return grouped
  }, [])
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
      entries: groupOmitted(selectedEntries.map(mapEntry)),
      hasEarlier: contextEntries.length > HISTORY_LIMIT,
    }
  } catch (cause) {
    if (cause instanceof PiSessionHistorySourceChangedError) throw cause
    throw new Error('Failed to read Pi session history', { cause })
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}
