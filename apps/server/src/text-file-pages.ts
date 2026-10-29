import { sep } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { TextFileCursor, TextFilePage, TextFilePageRequest, TextFileRead, TextFileStat } from '@pi-nest/contracts'
import { openPreviewFile, PreviewError } from './preview-file.js'
import { isWorkspacePath } from './workspace-file-path.js'

export const textPageBytes = 256 * 1024
const maxLines = 1000
const seekBytes = 8 * 1024 * 1024
export const textCursorSchema = z.object({ offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), midLine: z.boolean(), version: z.string().min(1).max(256) }).strict()
export const textPageRequestFields = { cursor: textCursorSchema.optional(), direction: z.enum(['next', 'previous']).optional(), targetLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - maxLines).optional() }
type Input = { cwd: string; path: string; searchRoot?: string; allowedRoot?: string; signal?: AbortSignal } & TextFilePageRequest
type Opened = Awaited<ReturnType<typeof openPreviewFile>>
function version(info: Opened['info']) { return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') }
function metadata(opened: Opened): TextFileStat {
  if (opened.info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new PreviewError('文件大小超出可寻址范围。', 413)
  return { path: opened.path.split(sep).join('/'), version: version(opened.info), fileBytes: Number(opened.info.size) }
}
async function verify(opened: Opened, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const current = await realpath(opened.canonical)
  if (opened.allowedRoot && !isWorkspacePath(opened.allowedRoot, current)) throw new PreviewError('文件位于项目范围之外。', 403)
  const [descriptor, target] = await Promise.all([opened.file.stat({ bigint: true }), stat(current, { bigint: true })])
  if (version(descriptor) !== version(opened.info) || version(target) !== version(opened.info)) throw new PreviewError('文件已更新，请刷新后继续读取。', 409, 'FILE_VERSION_CHANGED')
}
export async function readTextFileStat(input: Input): Promise<TextFileStat> {
  input.signal?.throwIfAborted()
  const opened = await openPreviewFile(input.cwd, input.path, input.searchRoot, input.allowedRoot)
  try { await verify(opened, input.signal); return metadata(opened) } finally { await opened.file.close() }
}
async function bytes(file: FileHandle, offset: number, count: number, signal?: AbortSignal, stopAfterLines?: number) {
  const buffer = Buffer.alloc(count)
  let length = 0
  let lines = 0
  while (length < count) {
    signal?.throwIfAborted()
    const { bytesRead } = await file.read(buffer, length, Math.min(64 * 1024, count - length), offset + length)
    if (!bytesRead) break
    const previous = length
    length += bytesRead
    if (stopAfterLines !== undefined) {
      for (let i = previous; i < length; i++) if (buffer[i] === 10) lines++
      if (lines >= stopAfterLines) break
    }
  }
  signal?.throwIfAborted()
  return buffer.subarray(0, length)
}
function decode(buffer: Buffer, offset: number) {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: offset !== 0 }).decode(buffer) }
  catch { throw new PreviewError('此文件不是 UTF-8 文本，暂不支持预览。', 415) }
  if (text.includes('\0')) throw new PreviewError('二进制文件暂不支持预览。', 415)
  return text
}
async function page(opened: Opened, meta: TextFileStat, cursor: TextFileCursor, previous: boolean, lineLimit: number, signal?: AbortSignal): Promise<TextFilePage> {
  const offset = previous ? Math.max(0, cursor.offset - textPageBytes) : cursor.offset
  // Read a look-ahead for UTF-8 / CRLF boundaries, or one look-behind for a backward window.
  const base = previous ? Math.max(0, offset - 4) : offset
  const buffer = await bytes(opened.file, base, previous ? cursor.offset - base : textPageBytes + 4, signal, previous ? undefined : lineLimit)
  let start = offset - base
  let end = previous ? buffer.length : Math.min(buffer.length, textPageBytes)
  if (previous) {
    while (start < end && (buffer[start]! & 0xc0) === 0x80) start++
    if (buffer[start] === 10 && start > 0 && buffer[start - 1] === 13) start++
    let lines = 0
    for (let i = end - 1; i >= start; i--) if (buffer[i] === 10 && ++lines > maxLines) { start = i + 1; break }
  } else {
    while (end < buffer.length && end > 0 && (buffer[end]! & 0xc0) === 0x80) end--
    if (buffer[end - 1] === 13 && buffer[end] === 10) end--
    let lines = 0
    for (let i = start; i < end; i++) if (buffer[i] === 10 && ++lines >= lineLimit) { end = i + 1; break }
  }
  const selected = buffer.subarray(start, end)
  const newlines = selected.reduce((sum, byte) => sum + Number(byte === 10), 0)
  const absoluteStart = base + start
  const first: TextFileCursor = previous ? { ...cursor, offset: absoluteStart, line: cursor.line - newlines, midLine: absoluteStart > 0 && buffer[start - 1] !== 10 } : cursor
  if (first.line < 1) throw new PreviewError('文件游标无效。', 400)
  const endOffset = base + end
  const eof = endOffset >= meta.fileBytes
  const endsWithNewline = selected.at(-1) === 10
  const next: TextFileCursor = { offset: endOffset, line: first.line + newlines, midLine: selected.length > 0 && !endsWithNewline, version: meta.version }
  if (!selected.length && buffer.length) throw new PreviewError('此文件不是有效的 UTF-8 文本。', 415)
  const text = decode(selected, absoluteStart)
  return { ...meta, kind: 'page', cursor: first, text, startsMidLine: first.midLine, endsMidLine: !eof && next.midLine, endOffset, lastLine: text.length ? next.line - Number(endsWithNewline) : first.line, nextCursor: eof ? undefined : next, eof }
}
async function seek(opened: Opened, cursor: TextFileCursor, target: number, fileBytes: number, signal?: AbortSignal) {
  let scanned = 0
  while (cursor.line < target && cursor.offset < fileBytes && seekBytes - scanned >= 4) {
    const limit = Math.min(64 * 1024, seekBytes - scanned)
    const buffer = await bytes(opened.file, cursor.offset, limit + 4, signal)
    let end = Math.min(limit, buffer.length)
    while (end < buffer.length && end > 0 && (buffer[end]! & 0xc0) === 0x80) end--
    if (buffer[end - 1] === 13 && buffer[end] === 10) end--
    if (!end) throw new PreviewError('此文件不是有效的 UTF-8 文本。', 415)
    let line = cursor.line
    for (let i = 0; i < end; i++) if (buffer[i] === 10 && ++line === target) { end = i + 1; break }
    decode(buffer.subarray(0, end), cursor.offset)
    cursor = { ...cursor, offset: cursor.offset + end, line, midLine: buffer[end - 1] !== 10 }
    scanned += end
  }
  return cursor
}
export async function readTextFilePage(input: Input): Promise<TextFileRead> {
  input.signal?.throwIfAborted()
  const parsed = z.object(textPageRequestFields).strict().safeParse({ cursor: input.cursor, direction: input.direction, targetLine: input.targetLine })
  if (!parsed.success || input.direction === 'previous' && !input.cursor) throw new PreviewError('文件分页请求无效。', 400)
  const opened = await openPreviewFile(input.cwd, input.path, input.searchRoot, input.allowedRoot)
  try {
    const meta = metadata(opened)
    let cursor = input.cursor ?? { offset: 0, line: 1, midLine: false, version: meta.version }
    if (cursor.version !== meta.version) throw new PreviewError('文件已更新，请刷新后继续读取。', 409, 'FILE_VERSION_CHANGED')
    if (cursor.offset > meta.fileBytes || cursor.line > cursor.offset + 1 || cursor.offset === 0 && (cursor.line !== 1 || cursor.midLine)) throw new PreviewError('文件游标超出文件范围。', 400)
    if (input.direction !== 'previous' && input.targetLine !== undefined && cursor.line < input.targetLine) {
      cursor = await seek(opened, cursor, input.targetLine, meta.fileBytes, input.signal)
      if (cursor.line < input.targetLine && cursor.offset < meta.fileBytes) {
        await verify(opened, input.signal)
        return { ...meta, kind: 'seeking', cursor }
      }
      if (cursor.offset >= meta.fileBytes && cursor.offset > 0) {
        const last = await page(opened, meta, cursor, true, maxLines, input.signal)
        await verify(opened, input.signal)
        return last
      }
    }
    const result = await page(opened, meta, cursor, input.direction === 'previous', maxLines, input.signal)
    await verify(opened, input.signal)
    return result
  } finally { await opened.file.close() }
}
