import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  discoverPiSessionFiles,
  mapLimit,
  readPiSessionFileSignature,
  readPiSessionHeader,
  readPiSessionSummary,
  samePiSessionFileIdentity,
  samePiSessionFileSignature,
} from './session-files.js'

const CREATED = '2026-09-19T08:00:00.000Z'
const CWD = '/work/project'
const HEADER = { type: 'session', version: 3, id: 'session-1', timestamp: CREATED, cwd: CWD }

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pi-session-files-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function sessionFile(name = 'session.jsonl') {
  const file = join(directory, name)
  writeFileSync(file, `${JSON.stringify(HEADER)}\n`)
  return file
}

describe('readPiSessionHeader', () => {
  it('reads only a bounded file head and tolerates malformed leading lines', async () => {
    const file = join(directory, 'late.jsonl')
    writeFileSync(file, `garbage\n\n${JSON.stringify(HEADER)}\n${'x'.repeat(2_000_000)}\n`)

    await expect(readPiSessionHeader(file)).resolves.toMatchObject({ header: { cwd: CWD, id: 'session-1' } })
  })

  it('accepts a final header without a newline and rejects a non-session first entry', async () => {
    const withoutNewline = join(directory, 'no-newline.jsonl')
    writeFileSync(withoutNewline, JSON.stringify(HEADER))
    await expect(readPiSessionHeader(withoutNewline)).resolves.toMatchObject({ header: { id: 'session-1' } })

    const nonSession = join(directory, 'custom-first.jsonl')
    writeFileSync(nonSession, `${JSON.stringify({ type: 'custom', id: 'custom' })}\n${JSON.stringify(HEADER)}\n`)
    await expect(readPiSessionHeader(nonSession)).resolves.toBeUndefined()
  })

  it('refuses headers beyond the bounded scan and unreadable paths', async () => {
    const oversized = join(directory, 'oversized.jsonl')
    writeFileSync(oversized, `${'x'.repeat(1024 * 1024 + 1)}${JSON.stringify(HEADER)}\n`)
    await expect(readPiSessionHeader(oversized)).resolves.toBeUndefined()

    await expect(readPiSessionHeader(join(directory, 'missing.jsonl'))).resolves.toBeUndefined()
    await expect(readPiSessionHeader(directory)).resolves.toBeUndefined()
  })
})

describe('readPiSessionSummary', () => {
  it('keeps the first user text, latest name including clears, and last activity', async () => {
    const file = join(directory, 'summary.jsonl')
    const entries = [
      HEADER,
      { type: 'message', id: 'u1', parentId: null, timestamp: CREATED, message: { role: 'user', content: 'first question', timestamp: Date.parse('2026-09-19T09:00:00.000Z') } },
      { type: 'session_info', id: 'n1', parentId: 'u1', timestamp: CREATED, name: 'Name one' },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: CREATED, message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: Date.parse('2026-09-19T10:00:00.000Z') } },
      { type: 'session_info', id: 'n2', parentId: 'a1', timestamp: CREATED, name: '  ' },
      '{broken',
      { type: 'message', id: 'u2', parentId: 'a1', timestamp: CREATED, message: { role: 'user', content: 'second question', timestamp: Date.parse('2026-09-19T11:00:00.000Z') } },
    ]
    writeFileSync(file, entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n')

    const read = await readPiSessionSummary(file)
    expect(read?.header).toMatchObject({ cwd: CWD, id: 'session-1' })
    expect(read?.summary).toMatchObject({
      cwd: CWD,
      firstMessage: 'first question',
      id: 'session-1',
      name: undefined,
      sessionFile: file,
      updatedAt: new Date(Date.parse('2026-09-19T11:00:00.000Z')).toISOString(),
    })
    expect(read?.signature.size).toBeGreaterThan(0)
  })

  it('rejects files without a valid session header and missing paths', async () => {
    const file = join(directory, 'invalid.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'custom', id: 'custom' })}\n`)
    await expect(readPiSessionSummary(file)).resolves.toBeUndefined()

    const primitive = join(directory, 'primitive.jsonl')
    writeFileSync(primitive, `5\n${JSON.stringify(HEADER)}\n`)
    await expect(readPiSessionSummary(primitive)).resolves.toBeUndefined()
    await expect(readPiSessionSummary(join(directory, 'missing.jsonl'))).resolves.toBeUndefined()
  })

  it('returns an undefined first message for header-only sessions', async () => {
    const file = sessionFile()
    const read = await readPiSessionSummary(file)
    expect(read?.summary).toMatchObject({ createdAt: CREATED, firstMessage: undefined, name: undefined, updatedAt: CREATED })
  })
})

describe('session file metadata', () => {
  it('discovers nested JSONL files only and reports a missing root as complete', async () => {
    const project = join(directory, 'sessions', '--project--')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify(HEADER)}\n`)
    writeFileSync(join(project, 'ignored.txt'), '')
    writeFileSync(join(directory, 'sessions', 'root-level.jsonl'), `${JSON.stringify(HEADER)}\n`)

    const discovery = await discoverPiSessionFiles(join(directory, 'sessions'))
    expect(discovery).toEqual({ complete: true, files: [join(project, 'one.jsonl')] })
    await expect(discoverPiSessionFiles(join(directory, 'missing'))).resolves.toEqual({ complete: true, files: [] })
  })

  it('reads identity/signature metadata and compares it field by field', async () => {
    const file = sessionFile()
    const signature = await readPiSessionFileSignature(file)
    expect(signature).toBeDefined()
    expect(await readPiSessionFileSignature(join(directory, 'missing'))).toBeUndefined()
    expect(samePiSessionFileSignature(signature!, { ...signature! })).toBe(true)
    expect(samePiSessionFileIdentity(signature!, { ...signature!, size: signature!.size + 1 })).toBe(true)
    expect(samePiSessionFileSignature(signature!, { ...signature!, size: signature!.size + 1 })).toBe(false)
    expect(samePiSessionFileIdentity(signature!, { ...signature!, ino: signature!.ino + 1 })).toBe(false)
  })

  it('maps items with a fixed concurrency limit without reordering results', async () => {
    let active = 0
    let peak = 0
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return value * 2
    })
    expect(results).toEqual([2, 4, 6, 8, 10])
    expect(peak).toBe(2)
  })
})
