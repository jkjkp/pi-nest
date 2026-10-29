import { mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileChangeTracker } from './file-change-tracker.js'

let directory: string
let tracker: FileChangeTracker
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'pi-file-stats-')); tracker = new FileChangeTracker() })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('counts new and overwritten files against their first baseline without summing repeated edits', () => {
  const path = tracker.before(directory, 'new.ts')
  writeFileSync(path, 'one\ntwo\n')
  expect(tracker.record(path, true)).toMatchObject({ added: 2, removed: 0, changeType: 'created' })
  tracker.before(directory, './new.ts')
  writeFileSync(path, 'three\n')
  expect(tracker.record(path, true)).toMatchObject({ added: 1, removed: 0 })
  tracker.reset()
  tracker.before(directory, 'new.ts')
  writeFileSync(path, 'three\nfour\n')
  expect(tracker.record(path, true)).toMatchObject({ added: 1, removed: 0, changeType: 'modified' })
  tracker.before(directory, 'new.ts')
  writeFileSync(path, 'five\n')
  expect(tracker.record(path, true)).toMatchObject({ added: 1, removed: 1 })
})

it('uses the final bytes, handles deletion and partial failure, and leaves no snapshots on disk', () => {
  const path = join(directory, 'a.ts')
  writeFileSync(path, 'old\n')
  tracker.before(directory, path)
  writeFileSync(path, 'partial\n')
  expect(tracker.record(path, false)).toMatchObject({ added: 1, removed: 1 })
  writeFileSync(path, 'final\nextra\n')
  expect(tracker.finish()).toMatchObject([{ added: 2, removed: 1 }])
  unlinkSync(path)
  expect(tracker.finish()).toMatchObject([{ added: 0, removed: 1, changeType: 'deleted' }])
})

it('normalizes CRLF and reports zero for reverted changes, including missing trailing newlines', () => {
  const path = join(directory, 'a.ts')
  writeFileSync(path, 'one\r\ntwo')
  tracker.before(directory, path)
  writeFileSync(path, 'one\ntwo')
  expect(tracker.record(path, true)).toMatchObject({ added: 0, removed: 0, changeType: 'unchanged' })
  writeFileSync(path, 'edited\n')
  tracker.record(path, true)
  writeFileSync(path, 'one\r\ntwo')
  expect(tracker.finish()).toMatchObject([{ added: 0, removed: 0, changeType: 'unchanged' }])
})

it('does not invent counts for binary, invalid UTF-8, oversized or unreadable entries', () => {
  for (const content of [Buffer.from([0, 1, 2]), Buffer.from([255, 255])]) {
    const path = join(directory, 'binary')
    writeFileSync(path, content)
    tracker.reset(); tracker.before(directory, path)
    expect(tracker.record(path, true)).toMatchObject({ reason: 'binary' })
  }
  const large = join(directory, 'large')
  writeFileSync(large, Buffer.alloc(1024 * 1024 + 1, 97))
  tracker.before(directory, large)
  expect(tracker.record(large, true)).toMatchObject({ reason: 'too_large' })
  const folder = join(directory, 'folder'); mkdirSync(folder)
  tracker.before(directory, folder)
  expect(tracker.record(folder, true)).toMatchObject({ reason: 'unreadable' })
  expect(tracker.after(join(directory, 'unknown'))).toMatchObject({ reason: 'unrecorded' })
})

it('excludes failure-only no-op calls, caps retained baselines, and clears state between user turns', () => {
  const path = tracker.before(directory, 'missing')
  tracker.record(path, false)
  expect(tracker.finish()).toEqual([])
  for (let index = 0; index < 4096; index++) tracker.before(directory, `${index}`)
  expect(tracker.after(join(directory, '4095'))).toMatchObject({ reason: 'unrecorded' })
  tracker.reset()
  expect(tracker.after(path)).toMatchObject({ reason: 'unrecorded' })
})


it('captures partial mutations on interruption even without a tool-result notification', () => {
  const path = join(directory, 'interrupted.ts')
  writeFileSync(path, 'before\n')
  tracker.before(directory, path)
  writeFileSync(path, 'partial\nextra\n')
  expect(tracker.finish()).toMatchObject([{ added: 2, removed: 1, changeType: 'modified' }])
})

it('finds indirect workspace changes without Git, preserving the original baseline and net counts', () => {
  mkdirSync(join(directory, '中文 目录'))
  const yaml = join(directory, '中文 目录/fs-rules.yaml')
  const deleted = join(directory, 'old.json')
  writeFileSync(yaml, 'rules:\n  - old\n')
  writeFileSync(deleted, 'old\n')
  tracker.beforeWorkspace(directory)
  writeFileSync(yaml, 'rules:\n  - temporary\n')
  tracker.before(directory, yaml)
  writeFileSync(yaml, 'rules:\n  - final\n  - extra\n')
  renameSync(deleted, join(directory, 'renamed.json'))
  writeFileSync(join(directory, 'Makefile'), 'all:\n')
  expect(tracker.finish()).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: yaml, added: 2, removed: 1, changeType: 'modified' }),
    expect.objectContaining({ path: deleted, added: 0, removed: 1, changeType: 'deleted' }),
    expect.objectContaining({ path: join(directory, 'renamed.json'), added: 1, removed: 0, changeType: 'created' }),
    expect.objectContaining({ path: join(directory, 'Makefile'), added: 1, removed: 0, changeType: 'created' }),
  ]))
  expect(tracker.incomplete).toBe(false)
  tracker.reset()
  tracker.beforeWorkspace(directory)
  expect(tracker.finish()).toEqual([])
})

it('skips dependencies, Git internals, symlinks and its own session log', () => {
  for (const name of ['.git', 'node_modules']) mkdirSync(join(directory, name))
  const sessionFile = join(directory, 'session.jsonl')
  writeFileSync(sessionFile, 'before\n')
  symlinkSync(tmpdir(), join(directory, 'outside'))
  tracker.beforeWorkspace(directory, sessionFile)
  writeFileSync(sessionFile, 'after\n')
  for (const name of ['.git', 'node_modules']) writeFileSync(join(directory, name, 'ignored'), 'ignored\n')
  expect(tracker.finish()).toEqual([])
})

it('lists changed binary and oversized files without counting unchanged ones', () => {
  const binary = join(directory, 'image.png')
  const large = join(directory, 'large.log')
  writeFileSync(binary, Buffer.from([0, 1]))
  writeFileSync(large, Buffer.alloc(1024 * 1024 + 1, 97))
  tracker.beforeWorkspace(directory)
  expect(tracker.finish()).toEqual([])
  writeFileSync(binary, Buffer.from([0, 2, 3]))
  writeFileSync(large, Buffer.alloc(1024 * 1024 + 2, 98))
  expect(tracker.finish()).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: binary, reason: 'binary' }),
    expect.objectContaining({ path: large, reason: 'too_large' }),
  ]))
})

it('reports an incomplete scan instead of failing the tool when the workspace is unreadable', () => {
  tracker.beforeWorkspace(join(directory, 'missing'))
  expect(tracker.finish()).toEqual([])
  expect(tracker.incomplete).toBe(true)
  tracker.reset()
  expect(tracker.incomplete).toBe(false)
})

it('bounds workspace traversal without inventing deletions for files outside a partial scan', () => {
  const original = join(directory, 'original.txt')
  writeFileSync(original, 'keep\n')
  tracker.beforeWorkspace(directory)
  for (let index = 0; index < 4100; index++) writeFileSync(join(directory, `file-${index}`), '')
  const changes = tracker.finish()
  expect(tracker.incomplete).toBe(true)
  expect(changes.some((change) => 'changeType' in change && change.changeType === 'deleted')).toBe(false)
})

it('does not label previously unscanned existing files as new after a partial baseline scan', () => {
  writeFileSync(join(directory, 'existing.yaml'), 'unchanged\n')
  const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(251)
  try { tracker.beforeWorkspace(directory) }
  finally { now.mockRestore() }
  expect(tracker.finish()).toEqual([])
  expect(tracker.incomplete).toBe(true)
})

it('keeps paths when the baseline byte budget is exhausted and does not invent line counts', () => {
  for (let index = 0; index < 17; index++) writeFileSync(join(directory, `${index}.txt`), Buffer.alloc(1024 * 1024, 97))
  tracker.beforeWorkspace(directory)
  for (let index = 0; index < 17; index++) writeFileSync(join(directory, `${index}.txt`), 'changed\n')
  const changes = tracker.finish()
  expect(changes).toHaveLength(17)
  expect(changes.some((change) => 'reason' in change && change.reason === 'too_large')).toBe(true)
  expect(tracker.incomplete).toBe(true)
})

it('omits reverted indirect edits and still captures project-external direct writes', () => {
  const path = join(directory, 'a.yaml')
  writeFileSync(path, 'original\n')
  tracker.beforeWorkspace(directory)
  writeFileSync(path, 'temporary\n')
  writeFileSync(path, 'original\n')
  expect(tracker.finish()).toEqual([])
  const external = mkdtempSync(join(tmpdir(), 'pi-file-stats-external-'))
  try {
    const target = tracker.before(directory, join(external, 'outside.json'))
    writeFileSync(target, '{}\n')
    expect(tracker.record(target, true)).toMatchObject({ changeType: 'created', added: 1, removed: 0 })
    expect(tracker.finish()).toMatchObject([{ path: target, changeType: 'created', added: 1, removed: 0 }])
  } finally { rmSync(external, { recursive: true, force: true }) }
})
