import { afterEach, describe, expect, it, vi } from 'vitest'

import { nextElapsedTickDelay, startElapsedClock } from './turn-elapsed-clock.js'

afterEach(() => vi.useRealTimers())

describe('elapsed clock', () => {
  it('aligns running updates to each displayed elapsed second', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-22T00:00:00.250Z'))
    const ticks: number[] = []
    const stop = startElapsedClock('2026-09-22T00:00:00.000Z', (now) => ticks.push(now - Date.parse('2026-09-22T00:00:00.000Z')))

    vi.advanceTimersByTime(4_750)

    expect(ticks).toEqual([1_000, 2_000, 3_000, 4_000, 5_000])
    stop()
  })

  it('cleans up its pending timeout and handles an invalid start timestamp safely', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-22T00:00:00.000Z'))
    const onTick = vi.fn()
    const stop = startElapsedClock('not-a-date', onTick)

    expect(nextElapsedTickDelay('not-a-date')).toBe(1_000)
    stop()
    vi.advanceTimersByTime(2_000)
    expect(onTick).not.toHaveBeenCalled()
  })
})
