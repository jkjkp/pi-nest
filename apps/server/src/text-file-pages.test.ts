import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readTextFilePage, readTextFileStat, textPageBytes } from './text-file-pages.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(content: string | Buffer) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-nest-pages-')); roots.push(cwd)
  await writeFile(join(cwd, 'file'), content)
  return { cwd, path: 'file' }
}
it('opens large files in bounded pages and reads backwards without losing bytes', async () => {
  const input = await fixture('hello\r\n'.repeat(300_000))
  const first = await readTextFilePage(input)
  expect(first.kind).toBe('page'); if (first.kind !== 'page') return
  expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(textPageBytes)
  expect(first.text.split('\n').length - 1).toBe(1000)
  const second = await readTextFilePage({ ...input, cursor: first.nextCursor })
  if (second.kind !== 'page') throw new Error('not a page')
  expect(second.cursor.line).toBe(1001)
  const previous = await readTextFilePage({ ...input, cursor: second.cursor, direction: 'previous' })
  if (previous.kind !== 'page') throw new Error('not a page')
  expect(previous.text).toBe(first.text)
  expect(previous.nextCursor).toEqual(second.cursor)
})
it('splits giant lines at UTF-8 boundaries, preserves CRLF and BOM, and rejoins exactly', async () => {
  const content = '\uFEFF' + '中文🙂'.repeat(60_000) + '\r\nlast'
  const input = await fixture(content)
  let page = await readTextFilePage(input)
  let text = ''; let count = 0
  while (page.kind === 'page') {
    text += page.text; count++
    expect(page.text).not.toContain('\uFFFD')
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(textPageBytes)
    if (!page.nextCursor) break
    const next = await readTextFilePage({ ...input, cursor: page.nextCursor })
    if (next.kind === 'page' && page.endsMidLine) expect(next.startsMidLine).toBe(true)
    page = next
  }
  expect(count).toBeGreaterThan(1)
  expect(text).toBe(content.slice(1))
})
it('seeks in bounded batches, returns an EOF window for absent lines, and rejects stale cursors', async () => {
  const input = await fixture(('x'.repeat(1000) + '\n').repeat(15_000))
  let result = await readTextFilePage({ ...input, targetLine: 14_999 })
  expect(result.kind).toBe('seeking')
  while (result.kind === 'seeking') result = await readTextFilePage({ ...input, cursor: result.cursor, targetLine: 14_999 })
  expect(result.cursor.line).toBe(14_999)
  expect(result.eof).toBe(true)
  const end = await readTextFilePage({ ...input, cursor: result.cursor, targetLine: 99_999 })
  expect(end.kind).toBe('page')
  await writeFile(join(input.cwd, 'file'), 'changed')
  await expect(readTextFilePage({ ...input, cursor: result.cursor })).rejects.toMatchObject({ status: 409, code: 'FILE_VERSION_CHANGED' })
})
it('rejects invalid UTF-8, binary, invalid cursors, and cancellation', async () => {
  for (const content of [Buffer.from([0xff]), Buffer.from('a\0b')]) {
    const input = await fixture(content)
    await expect(readTextFilePage(input)).rejects.toMatchObject({ status: 415 })
  }
  const input = await fixture('abc')
  const stat = await readTextFileStat(input)
  await expect(readTextFilePage({ ...input, cursor: { offset: -1, line: 1, midLine: false, version: stat.version } })).rejects.toMatchObject({ status: 400 })
  const controller = new AbortController(); controller.abort()
  await expect(readTextFilePage({ ...input, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
})

it('reads backwards through multi-byte long-line fragments without dropping characters', async () => {
  const content = '开始🙂'.repeat(55_000) + '\r\nend'
  const input = await fixture(content)
  let forward = await readTextFilePage(input)
  if (forward.kind !== 'page') throw new Error('not page')
  while (forward.nextCursor) {
    const next = await readTextFilePage({ ...input, cursor: forward.nextCursor })
    if (next.kind !== 'page') throw new Error('not page')
    forward = next
  }
  let reconstructed = forward.text
  while (forward.cursor.offset > 0) {
    const previous = await readTextFilePage({ ...input, cursor: forward.cursor, direction: 'previous' })
    if (previous.kind !== 'page') throw new Error('not page')
    expect(previous.nextCursor?.offset).toBe(forward.cursor.offset)
    reconstructed = previous.text + reconstructed
    forward = previous
  }
  expect(reconstructed).toBe(content)
})
it('opens the first window of a real 100 MiB log and handles CRLF at the byte cap', async () => {
  const input = await fixture('')
  const { open } = await import('node:fs/promises')
  const file = await open(join(input.cwd, 'file'), 'w')
  const block = Buffer.from('log record\n'.repeat(96_000))
  try { for (let i = 0; i < 100; i++) await file.write(block); } finally { await file.close() }
  const first = await readTextFilePage(input)
  expect(first.fileBytes).toBeGreaterThan(100 * 1024 * 1024)
  if (first.kind !== 'page') throw new Error('not page')
  expect(first.cursor.offset).toBe(0)
  expect(first.text).toBe('log record\n'.repeat(1000))
  expect(first.endOffset).toBe(11_000)
  await writeFile(join(input.cwd, 'file'), 'a'.repeat(textPageBytes - 1) + '\r\nlast')
  const boundary = await readTextFilePage(input)
  if (boundary.kind !== 'page') throw new Error('not page')
  expect(boundary.text.endsWith('\r')).toBe(false)
  const tail = await readTextFilePage({ ...input, cursor: boundary.nextCursor })
  if (tail.kind !== 'page') throw new Error('not page')
  expect(tail.text).toBe('\r\nlast')
})
