import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoverPiSessionFiles,
  readPiSessionFileSignature,
  readPiSessionHeader,
  readPiSessionSummary,
  type PiSessionSummary,
} from '@pi-nest/pi-adapter'

import { PiSessionIndex, type PiSessionIndexOptions } from './session-index.js'

const CREATED = '2026-09-19T08:00:00.000Z'
const FIRST = Date.parse('2026-09-19T09:00:00.000Z')
const SECOND = Date.parse('2026-09-19T10:00:00.000Z')
const THIRD = Date.parse('2026-09-19T11:00:00.000Z')
const CWD = '/work/project'

type Entry = Record<string, unknown>

let root: string
let projectDirectory: string
const indexes: PiSessionIndex[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-nest-index-'))
  projectDirectory = join(root, '--project--')
  mkdirSync(projectDirectory)
})

afterEach(() => {
  for (const index of indexes.splice(0)) index.close()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function header(id: string, cwd = CWD): Entry {
  return { type: 'session', version: 3, id, timestamp: CREATED, cwd }
}

function message(id: string, role: 'user' | 'assistant', content: string, timestamp: number, parentId: unknown = null): Entry {
  return { type: 'message', id, parentId, timestamp: CREATED, message: { role, content, timestamp } }
}

function info(id: string, name: string, parentId: unknown = null): Entry {
  return { type: 'session_info', id, parentId, timestamp: CREATED, name }
}

function serialize(entries: Entry[]) {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

function writeSession(name: string, id: string, entries: Entry[] = [], cwd = CWD) {
  const file = join(projectDirectory, name)
  writeFileSync(file, serialize([header(id, cwd), ...entries]))
  return file
}

function append(file: string, entry: Entry) {
  appendFileSync(file, `${JSON.stringify(entry)}\n`)
}

function createIndex(overrides: PiSessionIndexOptions = {}) {
  const counters = { discovery: 0, header: 0, summary: 0 }
  const index = new PiSessionIndex({
    directory: root,
    reconcileIntervalMs: 0,
    reconcileWindowMs: 0,
    watch: false,
    ...overrides,
    discovery: async (directory) => {
      counters.discovery++
      return (overrides.discovery ?? discoverPiSessionFiles)(directory)
    },
    readHeader: async (file) => {
      counters.header++
      return (overrides.readHeader ?? readPiSessionHeader)(file)
    },
    readSummary: async (file) => {
      counters.summary++
      return (overrides.readSummary ?? readPiSessionSummary)(file)
    },
    stat: async (file) => (overrides.stat ?? readPiSessionFileSignature)(file),
  })
  indexes.push(index)
  return { counters, index }
}

function session(sessions: PiSessionSummary[], id: string) {
  return sessions.find((candidate) => candidate.id === id)
}

describe('PiSessionIndex', () => {
  it('builds bindings from file heads and loads summaries only for list()', async () => {
    writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    writeSession('two.jsonl', 'two', [message('u2', 'user', 'second question', SECOND)])
    const { counters, index } = createIndex({ reconcileWindowMs: 60_000 })

    await expect(index.resolve('one')).resolves.toEqual({ cwd: CWD, id: 'one', sessionFile: join(projectDirectory, 'one.jsonl') })
    expect(counters.discovery).toBe(1)
    expect(counters.summary).toBe(0)
    expect(await index.hasWorkspace(CWD)).toBe(true)
    expect(await index.hasWorkspace('/work/other')).toBe(false)
    expect(counters.discovery).toBe(1)
    expect(counters.summary).toBe(0)

    const sessions = await index.list()
    expect(sessions.map((candidate) => candidate.id).sort()).toEqual(['one', 'two'])
    expect(session(sessions, 'one')?.firstMessage).toBe('first question')
    expect(counters.summary).toBe(2)
    expect(counters.discovery).toBe(1)
  })

  it('serves warm resolves and workspace checks without body reads or a new directory scan', async () => {
    writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    writeSession('two.jsonl', 'two', [message('u2', 'user', 'second question', SECOND)])
    const { counters, index } = createIndex({ reconcileWindowMs: 60_000 })
    await index.list()
    counters.discovery = 0
    counters.header = 0
    counters.summary = 0

    const bindings = await Promise.all(Array.from({ length: 10 }, () => index.resolve('one')))
    expect(bindings.every((binding) => binding?.id === 'one')).toBe(true)
    expect(counters.header).toBe(1)
    counters.header = 0

    expect(await index.hasWorkspace(CWD)).toBe(true)
    expect(counters.header).toBe(1)
    expect(counters.summary).toBe(0)
    expect(counters.discovery).toBe(0)
  })

  it('requires a live header binding before reporting a workspace', async () => {
    const file = writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    const { index } = createIndex({ reconcileWindowMs: 60_000 })
    await expect(index.hasWorkspace(CWD)).resolves.toBe(true)

    // Equal-length cwd, same inode and size: directory metadata cannot reveal this rewrite.
    writeFileSync(file, serialize([header('one', '/work/sibling'), message('u1', 'user', 'first question', FIRST)]))
    await expect(index.hasWorkspace(CWD)).resolves.toBe(false)
    await expect(index.hasWorkspace('/work/sibling')).resolves.toBe(true)
    await expect(index.hasWorkspace(CWD)).resolves.toBe(false)
  })

  it('rejects a workspace when its only session file disappears inside the reconcile window', async () => {
    const file = writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    const { index } = createIndex({ reconcileWindowMs: 60_000 })
    await expect(index.hasWorkspace(CWD)).resolves.toBe(true)

    unlinkSync(file)
    await expect(index.hasWorkspace(CWD)).resolves.toBe(false)
  })

  it('keeps a workspace valid when one binding is stale and another is valid', async () => {
    const stale = writeSession('a.jsonl', 'a', [message('u1', 'user', 'first', FIRST)])
    writeSession('b.jsonl', 'b', [message('u2', 'user', 'second', SECOND)])
    const { index } = createIndex({ reconcileWindowMs: 60_000 })
    await expect(index.hasWorkspace(CWD)).resolves.toBe(true)

    writeFileSync(stale, serialize([header('a', '/work/sibling'), message('u1', 'user', 'first', FIRST)]))
    await expect(index.hasWorkspace(CWD)).resolves.toBe(true)
    await expect(index.resolve('b')).resolves.toBeDefined()
  })

  it('shares one directory reconcile across concurrent cold requests', async () => {
    writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    writeSession('two.jsonl', 'two', [message('u2', 'user', 'second question', SECOND)])
    const { counters, index } = createIndex({ reconcileWindowMs: 60_000 })

    await Promise.all([
      index.list(),
      index.resolve('one'),
      index.resolve('two'),
      index.hasWorkspace(CWD),
    ])

    expect(counters.discovery).toBe(1)
    expect(counters.summary).toBe(2)
  })

  it('shares per-file summary reads between concurrent list calls', async () => {
    writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    writeSession('two.jsonl', 'two', [message('u2', 'user', 'second question', SECOND)])
    const { counters, index } = createIndex({ reconcileWindowMs: 60_000 })

    await Promise.all([index.list(), index.list()])

    expect(counters.summary).toBe(2)
  })

  it('does not rescan the directory for unknown IDs within the reconcile window', async () => {
    writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    const { counters, index } = createIndex({ reconcileWindowMs: 60_000 })
    await index.list()
    counters.discovery = 0

    for (let attempt = 0; attempt < 10; attempt++) await expect(index.resolve(`missing-${attempt}`)).resolves.toBeUndefined()

    expect(counters.discovery).toBe(0)
  })

  it('re-reads only the session whose file changed after an append', async () => {
    const one = writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    writeSession('two.jsonl', 'two', [message('u2', 'user', 'second question', SECOND)])
    const { counters, index } = createIndex()
    const before = await index.list()
    counters.summary = 0

    append(one, message('u3', 'user', 'follow up', SECOND))
    const after = await index.list()

    expect(counters.summary).toBe(1)
    expect(session(after, 'one')?.updatedAt).toBe(new Date(SECOND).toISOString())
    expect(session(after, 'two')?.updatedAt).toBe(session(before, 'two')?.updatedAt)
  })

  it('applies the latest native name, including an explicit clear', async () => {
    const file = writeSession('named.jsonl', 'named', [
      message('u1', 'user', 'question', FIRST),
      info('n1', 'First name', 'u1'),
    ])
    const { index } = createIndex()
    expect(session(await index.list(), 'named')?.name).toBe('First name')

    append(file, info('n2', '   ', 'n1'))
    expect(session(await index.list(), 'named')?.name).toBeUndefined()

    append(file, info('n3', 'Renamed', 'n2'))
    expect(session(await index.list(), 'named')?.name).toBe('Renamed')
  })

  it('reflects external creation and deletion and keeps workspace counts current', async () => {
    writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    const { index } = createIndex()
    await index.list()
    expect(await index.hasWorkspace('/work/other')).toBe(false)

    const two = writeSession('two.jsonl', 'two', [message('u2', 'user', 'other question', SECOND)], '/work/other')
    expect((await index.list()).map((candidate) => candidate.id).sort()).toEqual(['one', 'two'])
    expect(await index.hasWorkspace('/work/other')).toBe(true)

    unlinkSync(two)
    const remaining = await index.list()
    expect(remaining.map((candidate) => candidate.id)).toEqual(['one'])
    await expect(index.resolve('two')).resolves.toBeUndefined()
    expect(await index.hasWorkspace('/work/other')).toBe(false)
  })

  it('rejects a replaced file once, then registers the replacement', async () => {
    const file = writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    const { index } = createIndex({ reconcileWindowMs: 60_000 })
    await index.list()

    const replacement = join(root, 'replacement.jsonl')
    writeFileSync(replacement, serialize([header('one'), message('u2', 'user', 'replacement', THIRD)]))
    renameSync(replacement, file)

    await expect(index.resolve('one')).resolves.toBeUndefined()
    await expect(index.resolve('one')).resolves.toBeDefined()
    expect((await index.list()).find((candidate) => candidate.id === 'one')?.firstMessage).toBe('replacement')
  })

  it('never authorizes a cached binding after the header id changes', async () => {
    const file = writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    const { index } = createIndex({ reconcileWindowMs: 60_000 })
    await index.list()

    const replacement = join(root, 'replacement.jsonl')
    writeFileSync(replacement, serialize([header('other'), message('u2', 'user', 'other session', SECOND)]))
    renameSync(replacement, file)

    await expect(index.resolve('one')).resolves.toBeUndefined()
    await expect(index.resolve('other')).resolves.toBeDefined()
    await expect(index.resolve('one')).resolves.toBeUndefined()
  })

  it('discards a summary read that raced with a replacement so old data cannot win', async () => {
    const file = writeSession('one.jsonl', 'one', [
      message('u1', 'user', 'first question', FIRST),
      info('n1', 'Old name', 'u1'),
    ])
    let release!: () => void
    let reading!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { reading = resolve })
    let blockNext = true
    const { index } = createIndex({
      reconcileWindowMs: 60_000,
      readSummary: async (target) => {
        const read = await readPiSessionSummary(target)
        if (target === file && blockNext) {
          blockNext = false
          reading()
          await gate
        }
        return read
      },
    })

    const pending = index.list()
    await started

    const replacement = join(root, 'replacement.jsonl')
    writeFileSync(replacement, serialize([
      header('one'),
      message('u2', 'user', 'replacement question', THIRD),
      info('n2', 'New name', 'u2'),
    ]))
    renameSync(replacement, file)
    release()
    await pending

    expect(index.cachedSummary('one')?.name).not.toBe('Old name')
    expect(index.cachedSummary('one')?.firstMessage).not.toBe('first question')

    const refreshed = await index.list()
    expect(session(refreshed, 'one')?.name).toBe('New name')
    expect(session(refreshed, 'one')?.firstMessage).toBe('replacement question')
  })

  it('retries a failed summary read instead of dropping the session', async () => {
    writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    let failures = 1
    const { index } = createIndex({
      readSummary: async (file) => {
        if (failures-- > 0) throw new Error('temporary failure')
        return readPiSessionSummary(file)
      },
    })

    const first = await index.list()
    expect(first.map((candidate) => candidate.id)).toEqual(['one'])
    expect(session(first, 'one')?.firstMessage).toBeUndefined()

    const second = await index.list()
    expect(session(second, 'one')?.firstMessage).toBe('first question')
  })

  it('does not block a different file while one summary is being read', async () => {
    const one = writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    writeSession('two.jsonl', 'two', [message('u2', 'user', 'second question', SECOND)])
    let release!: () => void
    let reading!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { reading = resolve })
    let blockNext = true
    const { index } = createIndex({
      reconcileWindowMs: 60_000,
      readSummary: async (file) => {
        if (file === one && blockNext) {
          blockNext = false
          const read = await readPiSessionSummary(file)
          reading()
          await gate
          return read
        }
        return readPiSessionSummary(file)
      },
    })
    await index.hasWorkspace(CWD)

    const listing = index.list()
    await started
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('resolve was blocked')), 500))
    await expect(Promise.race([index.resolve('two'), timeout])).resolves.toMatchObject({ id: 'two' })
    release()
    await listing
  })

  it('registers new files immediately and refreshes after invalidate or forget', async () => {
    const file = writeSession('registered.jsonl', 'registered', [message('u1', 'user', 'registered question', FIRST)])
    const { counters, index } = createIndex({ reconcileWindowMs: 60_000 })
    index.register({ cwd: CWD, id: 'registered', sessionFile: file }, {
      createdAt: CREATED,
      cwd: CWD,
      firstMessage: 'provisional',
      id: 'registered',
      name: undefined,
      sessionFile: file,
      updatedAt: CREATED,
    })

    await expect(index.resolve('registered')).resolves.toBeDefined()
    expect(session(await index.list(), 'registered')?.firstMessage).toBe('registered question')
    counters.summary = 0

    index.invalidate('registered')
    await index.list()
    expect(counters.summary).toBe(1)

    index.forget('registered')
    await expect(index.resolve('registered')).resolves.toBeUndefined()
    expect(await index.list()).toEqual([])
  })

  it('keeps a session registered while an older directory scan is still running', async () => {
    writeSession('existing.jsonl', 'existing', [message('u1', 'user', 'existing question', FIRST)])
    let release!: () => void
    let captured!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const capturedScan = new Promise<void>((resolve) => { captured = resolve })
    let pauseNext = true
    const { index } = createIndex({
      reconcileWindowMs: 60_000,
      discovery: async (directory) => {
        const result = await discoverPiSessionFiles(directory)
        if (pauseNext) {
          pauseNext = false
          captured()
          await gate
        }
        return result
      },
    })

    const scanning = index.list()
    await capturedScan
    const created = writeSession('created.jsonl', 'created', [message('u2', 'user', 'created question', SECOND)])
    index.register({ cwd: CWD, id: 'created', sessionFile: created })
    // Re-registering the same path must also survive the older scan result.
    index.register({ cwd: CWD, id: 'created', sessionFile: created }, {
      createdAt: CREATED,
      cwd: CWD,
      firstMessage: 'created question',
      id: 'created',
      name: undefined,
      sessionFile: created,
      updatedAt: CREATED,
    })
    release()
    await scanning

    await expect(index.resolve('created')).resolves.toMatchObject({ id: 'created', sessionFile: created })
  })

  it('still removes a session deleted while an older directory scan is running', async () => {
    writeSession('existing.jsonl', 'existing', [message('u1', 'user', 'existing question', FIRST)])
    const doomed = writeSession('doomed.jsonl', 'doomed', [message('u2', 'user', 'doomed question', SECOND)])
    let scans = 0
    let release!: () => void
    let captured!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const capturedScan = new Promise<void>((resolve) => { captured = resolve })
    const { index } = createIndex({
      reconcileWindowMs: 0,
      discovery: async (directory) => {
        const result = await discoverPiSessionFiles(directory)
        scans += 1
        if (scans === 2) {
          captured()
          await gate
        }
        return result
      },
    })

    await index.list()
    const scanning = index.list()
    await capturedScan
    unlinkSync(doomed)
    release()
    await scanning

    await expect(index.resolve('doomed')).resolves.toBeUndefined()
    await expect(index.resolve('existing')).resolves.toBeDefined()
  })

  it('keeps known bindings when directory discovery is incomplete', async () => {
    const file = writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    let complete = true
    const { index } = createIndex({
      discovery: async (directory) => complete
        ? discoverPiSessionFiles(directory)
        : { complete: false, files: [] },
    })
    await index.list()

    complete = false
    expect(await index.hasWorkspace(CWD)).toBe(true)
    await expect(index.resolve('one')).resolves.toBeDefined()

    complete = true
    unlinkSync(file)
    expect(await index.hasWorkspace(CWD)).toBe(false)
  })

  it('invalidates a changed file from fs.watch without waiting for the metadata interval', async () => {
    const file = writeSession('watched.jsonl', 'watched', [message('u1', 'user', 'watched question', FIRST)])
    const { index } = createIndex({ reconcileIntervalMs: 0, reconcileWindowMs: 60_000, watch: true })
    await index.list()

    append(file, message('u2', 'user', 'watched follow up', SECOND))
    await vi.waitFor(async () => {
      expect(session(await index.list(), 'watched')?.updatedAt).toBe(new Date(SECOND).toISOString())
    }, { interval: 50, timeout: 5_000 })
  })

  it('clears its lifecycle timers on close', async () => {
    writeSession('one.jsonl', 'one', [message('u1', 'user', 'first question', FIRST)])
    vi.useFakeTimers()
    try {
      const { index } = createIndex({ reconcileIntervalMs: 5_000, watch: false })
      await index.list()
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      index.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
