import { mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
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
  for (let index = 0; index < 256; index++) tracker.before(directory, `${index}`)
  expect(tracker.after(join(directory, '255'))).toMatchObject({ reason: 'unrecorded' })
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
