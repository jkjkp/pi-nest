import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { join } from 'node:path'

export type PiSessionSummary = {
  parentSessionPath?: string
  createdAt?: string
  id: string
  name: string | undefined
  firstMessage: string | undefined
  sessionFile: string
  cwd: string | undefined
  updatedAt: string | undefined
}

/** The immutable identity used to authorize a session file before reading it. */
export type PiSessionBinding = {
  cwd: string | undefined
  id: string
  sessionFile: string
}

export type PiSessionFileSignature = {
  ctimeMs: number
  dev: number
  ino: number
  mtimeMs: number
  size: number
}

export type PiSessionHeader = {
  cwd?: string
  id: string
  parentSessionPath?: string
  timestamp?: string
}

export type PiSessionFileRead = {
  header: PiSessionHeader
  signature: PiSessionFileSignature
}

export type PiSessionSummaryRead = PiSessionFileRead & {
  summary: PiSessionSummary
}

/** Files discovered with the same directory rule as the Pi SDK. */
export type PiSessionDiscovery = {
  complete: boolean
  files: string[]
}

const NO_MESSAGES = '(no messages)'
const FIRST_MESSAGE_LIMIT = 120
const MAX_HEADER_SCAN_BYTES = 1024 * 1024
const READ_BUFFER_BYTES = 64 * 1024
const DIRECTORY_CONCURRENCY = 64
export const SUMMARY_CONCURRENCY = 10

/** Directory that the Pi SDK scans for native sessions. */
export function piSessionsDirectory() {
  return join(getAgentDir(), 'sessions')
}

export function sessionFirstMessage(raw: string | undefined) {
  const collapsed = raw?.replace(/\s+/g, ' ').trim()
  if (!collapsed || collapsed === NO_MESSAGES) return undefined

  const characters = Array.from(collapsed)
  return characters.length > FIRST_MESSAGE_LIMIT
    ? `${characters.slice(0, FIRST_MESSAGE_LIMIT).join('')}…`
    : collapsed
}

export function samePiSessionFileSignature(left: PiSessionFileSignature, right: PiSessionFileSignature) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

export function samePiSessionFileIdentity(left: PiSessionFileSignature, right: PiSessionFileSignature) {
  return left.dev === right.dev && left.ino === right.ino
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

function signatureOf(info: { ctimeMs: number; dev: number; ino: number; mtimeMs: number; size: number }): PiSessionFileSignature {
  return { ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, size: info.size }
}

export async function readPiSessionFileSignature(file: string): Promise<PiSessionFileSignature | undefined> {
  try {
    return signatureOf(await stat(file))
  } catch {
    return undefined
  }
}

/**
 * Enumerates `<agent dir>/sessions/<project>/*.jsonl`, matching SessionManager.listAll().
 * `complete` is false when a directory could not be read, so callers keep known bindings.
 */
export async function discoverPiSessionFiles(directory = piSessionsDirectory()): Promise<PiSessionDiscovery> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    return { complete: code === 'ENOENT' || code === 'ENOTDIR', files: [] }
  }

  let complete = true
  const projectDirectories = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => join(directory, entry.name))
  const nested = await mapLimit(projectDirectories, DIRECTORY_CONCURRENCY, async (projectDirectory) => {
    try {
      const names = await readdir(projectDirectory)
      return names.filter((name) => name.endsWith('.jsonl')).map((name) => join(projectDirectory, name))
    } catch {
      complete = false
      return []
    }
  })
  return { complete, files: nested.flat().sort() }
}

type HeaderCandidate = PiSessionHeader | null | undefined

function headerFromEntry(entry: Record<string, unknown>): PiSessionHeader {
  return {
    id: entry.id as string,
    ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
    ...(typeof entry.parentSession === 'string' ? { parentSessionPath: entry.parentSession } : {}),
    ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
  }
}

/**
 * Blank or malformed lines return undefined so discovery keeps scanning.
 * A parsed entry that is not a session header returns null and invalidates the file.
 */
function headerCandidate(line: string): HeaderCandidate {
  if (!line.trim()) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!value) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (entry.type !== 'session' || typeof entry.id !== 'string') return null
  return headerFromEntry(entry)
}

function finishHeader(buffer: Buffer, signature: PiSessionFileSignature): PiSessionFileRead | undefined {
  const candidate = headerCandidate(buffer.toString('utf8'))
  return candidate ? { header: candidate, signature } : undefined
}

function readHeaderFromHandle(handle: FileHandle, signature: PiSessionFileSignature): Promise<PiSessionFileRead | undefined> {
  return (async () => {
    let pending = Buffer.alloc(0)
    let offset = 0
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES)

    while (offset < MAX_HEADER_SCAN_BYTES) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, MAX_HEADER_SCAN_BYTES - offset), offset)
      if (bytesRead === 0) return finishHeader(pending, signature)
      offset += bytesRead
      pending = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : Buffer.from(buffer.subarray(0, bytesRead))

      let newline: number
      while ((newline = pending.indexOf(10)) !== -1) {
        const candidate = headerCandidate(pending.subarray(0, newline).toString('utf8'))
        pending = pending.subarray(newline + 1)
        if (candidate === undefined) continue
        return candidate === null ? undefined : { header: candidate, signature }
      }
    }

    // The SDK allows a header that ends exactly at the scan limit and probes EOF.
    const probe = Buffer.allocUnsafe(1)
    const { bytesRead } = await handle.read(probe, 0, 1, offset)
    return bytesRead === 0 ? finishHeader(pending, signature) : undefined
  })()
}

/** Reads only the file head; message bodies are never loaded. */
export async function readPiSessionHeader(file: string): Promise<PiSessionFileRead | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(file, 'r')
    const info = await handle.stat()
    if (!info.isFile()) return undefined
    const read = await readHeaderFromHandle(handle, signatureOf(info))
    if (!read) return undefined
    // The path must still resolve to the file whose head was read.
    const current = await stat(file)
    if (current.dev !== info.dev || current.ino !== info.ino) return undefined
    return read
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function textContent(content: unknown) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && !Array.isArray(block) && (block as Record<string, unknown>).type === 'text')
    .map((block) => {
      const text = (block as Record<string, unknown>).text
      return typeof text === 'string' ? text : ''
    })
    .join(' ')
}

function activityTime(entry: Record<string, unknown>, message: Record<string, unknown>) {
  if (typeof message.timestamp === 'number') return message.timestamp
  const timestamp = new Date(entry.timestamp as string).getTime()
  return Number.isNaN(timestamp) ? undefined : timestamp
}

/**
 * Minimal streaming equivalent of the SDK summary builder. It keeps only the
 * name, first user message, activity time and parent path used by this project.
 */
async function readSummaryFromHandle(handle: FileHandle, signature: PiSessionFileSignature, file: string): Promise<PiSessionSummaryRead | undefined> {
  let header: PiSessionHeader | undefined
  let name: string | undefined
  let firstMessage = ''
  let lastActivityTime: number | undefined
  let invalid = false
  let pending = ''
  const decoder = new StringDecoder('utf8')

  const consume = (line: string) => {
    if (invalid || !line.trim()) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      // A truthy non-object is a parsed non-session entry before the header.
      if (!value) return
      if (!header) invalid = true
      return
    }
    const entry = value as Record<string, unknown>

    if (!header) {
      if (entry.type !== 'session' || typeof entry.id !== 'string') invalid = true
      else header = headerFromEntry(entry)
      return
    }
    if (entry.type === 'session_info') {
      // The latest session_info wins, including an explicit clear.
      name = typeof entry.name === 'string' ? entry.name.trim() || undefined : undefined
      return
    }
    if (entry.type !== 'message') return
    const message = entry.message
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    const record = message as Record<string, unknown>
    if (typeof record.role !== 'string' || !('content' in record)) return
    if (record.role !== 'user' && record.role !== 'assistant') return

    const time = activityTime(entry, record)
    if (typeof time === 'number') lastActivityTime = Math.max(lastActivityTime ?? 0, time)
    const text = textContent(record.content)
    if (text && !firstMessage && record.role === 'user') firstMessage = text
  }

  const stream = handle.createReadStream({ autoClose: false, start: 0 })
  for await (const chunk of stream) {
    pending += decoder.write(chunk as Buffer)
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      consume(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      if (invalid) break
    }
    if (invalid) break
  }
  pending += decoder.end()
  if (!invalid && pending) consume(pending)
  if (invalid || !header) return undefined

  const headerTime = header.timestamp ? new Date(header.timestamp).getTime() : Number.NaN
  const modified = typeof lastActivityTime === 'number' && lastActivityTime > 0
    ? lastActivityTime
    : !Number.isNaN(headerTime)
      ? headerTime
      : signature.mtimeMs
  const modifiedDate = new Date(modified)
  const created = header.timestamp ? new Date(header.timestamp) : undefined

  return {
    header,
    signature,
    summary: {
      id: header.id,
      cwd: header.cwd || undefined,
      sessionFile: file,
      name,
      firstMessage: sessionFirstMessage(firstMessage),
      createdAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : undefined,
      updatedAt: Number.isNaN(modifiedDate.getTime()) ? new Date(signature.mtimeMs).toISOString() : modifiedDate.toISOString(),
      parentSessionPath: header.parentSessionPath,
    },
  }
}

/** Reads the whole file body and extracts only the fields this project exposes. */
export async function readPiSessionSummary(file: string): Promise<PiSessionSummaryRead | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(file, 'r')
    const info = await handle.stat()
    if (!info.isFile()) return undefined
    return await readSummaryFromHandle(handle, signatureOf(info), file)
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
