import { readFileSync } from 'node:fs'
import { z } from 'zod'

const count = z.number().finite().nonnegative()
export const runtimeStatisticsSchema = z.object({
  tokens: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count, total: count }),
  cost: count,
  contextUsage: z.object({ tokens: count.nullable(), contextWindow: count, percent: count.nullable() }).optional(),
  autoCompactionEnabled: z.boolean().optional(),
  cacheHitRate: count.max(100).optional(),
})

export function latestCacheHitRate(sessionFile: string) {
  try {
    const lines = readFileSync(sessionFile, 'utf8').trim().split('\n')
    for (let index = lines.length - 1; index >= 0; index--) {
      let entry
      try { entry = JSON.parse(lines[index]!) } catch { continue }
      if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue
      const usage = entry.message.usage
      if (!usage || ![usage.input, usage.cacheRead, usage.cacheWrite].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return undefined
      const total = usage.input + usage.cacheRead + usage.cacheWrite
      return total > 0 ? usage.cacheRead / total * 100 : undefined
    }
  } catch { /* Statistics remain usable if the native file is unavailable. */ }
  return undefined
}
