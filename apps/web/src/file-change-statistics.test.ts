import { expect, it } from 'vitest'
import { fileChangeStatistics } from './file-change-statistics.js'
import { timelineItems } from './timeline-model.js'

it('rejects malformed or unsupported native statistics rather than displaying fake counts', () => {
  const valid = { version: 1, path: '/project/a.ts', sequence: 1, added: 3, removed: 2, changeType: 'modified' }
  expect(fileChangeStatistics(valid)).toEqual(valid)
  for (const invalid of [null, [], {}, { ...valid, added: -1 }, { ...valid, removed: 1.5 }, { ...valid, version: 2 }, { ...valid, sequence: NaN }, { ...valid, path: '' }, { ...valid, changeType: 'invented' }]) expect(fileChangeStatistics(invalid)).toBeUndefined()
})

it('restores final statistics to the recorded user turn even when appended after a later user message', () => {
  const timestamp = '2026-10-26T00:00:00Z'
  const stats = { version: 1, path: '/project/a.ts', sequence: 2, added: 2, removed: 1, changeType: 'modified' }
  const entries = [
    { id: 'user-one', parentId: null, type: 'message', timestamp, raw: { type: 'message', message: { role: 'user', content: 'first' } } },
    { id: 'user-two', parentId: 'user-one', type: 'message', timestamp, raw: { type: 'message', message: { role: 'user', content: 'second' } } },
    { id: 'stats', parentId: 'user-two', type: 'custom', timestamp, raw: { type: 'custom', customType: 'pi-nest-file-changes', data: { version: 1, turnId: 'user-one', files: [stats, { path: 'malformed' }] } } },
  ]
  const turns = timelineItems(entries, [], [])
  expect(turns[0]?.fileChanges).toEqual([stats])
  expect(turns[1]?.fileChanges).toBeUndefined()
  expect(turns.every((turn) => turn.diagnostics.length === 0)).toBe(true)
})
