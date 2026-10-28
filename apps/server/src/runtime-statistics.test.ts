import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { cacheHitRateFromUsage, latestCacheHitRate, runtimeStatisticsSchema } from './runtime-statistics.js'

it('allows unknown context and strips native paths and other internal statistics', () => {
  const data = runtimeStatisticsSchema.parse({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.1, contextUsage: { tokens: null, percent: null, contextWindow: 1000000 }, autoCompactionEnabled: true, sessionFile: '/private/session', sessionId: 'native' })
  expect(data.contextUsage?.percent).toBeNull()
  expect(data).not.toHaveProperty('sessionFile')
  expect(data).not.toHaveProperty('sessionId')
  expect(() => runtimeStatisticsSchema.parse({ ...data, cost: -1 })).toThrow()
})

it('uses only the latest assistant request across native branches, not a cumulative cache ratio', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-stats-'))
  const path = join(directory, 'session.jsonl')
  try {
    const entry = (input: number, cacheRead: number, cacheWrite: number) => ({ type: 'message', message: { role: 'assistant', usage: { input, cacheRead, cacheWrite } } })
    writeFileSync(path, [entry(500, 0, 0), entry(1, 998, 1), { type: 'compaction' }].map((entry) => JSON.stringify(entry)).join('\n') + '\n{')
    expect(latestCacheHitRate(path)).toBeCloseTo(99.8)
    writeFileSync(path, JSON.stringify(entry(0, 0, 0)))
    expect(latestCacheHitRate(path)).toBeUndefined()
    expect(latestCacheHitRate(join(directory, 'missing'))).toBeUndefined()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('computes cache hit rate from the same usage shape used by native events', () => {
  expect(cacheHitRateFromUsage({ input: 1, cacheRead: 998, cacheWrite: 1 })).toBeCloseTo(99.8)
  expect(cacheHitRateFromUsage({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined()
})
