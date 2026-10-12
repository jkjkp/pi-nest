import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TurnNavigationRail } from './turn-navigation-rail.js'
import { railAlignedOffset, railScrollWindow, railWindowStart } from './turn-navigation-rail-state.js'

const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `turn-${index + 1}`, index: index + 1, promptPreview: `prompt ${index + 1}`, startedAt: '2026-09-24T00:00:00.000Z' }))

describe('ten-node conversation navigation', () => {
  it.each([0, 1, 2, 9, 10, 11, 3000])('bounds visible markers for %i turns without mounting closed history', (count) => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={entries(count)} onJump={() => undefined} />)
    expect((markup.match(/data-rail-marker=""/g) ?? []).length).toBe(count < 2 ? 0 : Math.min(10, count))
    expect(markup).not.toContain('data-turn-outline-id')
    expect(markup).not.toContain('<svg')
  })
  it('highlights the current user turn and keeps the navigation on the right', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail activeTurnId="turn-51" entries={entries(100)} onJump={() => undefined} />)
    expect(markup).toContain('data-active-turn-marker="turn-51"')
    expect(markup).toContain('absolute right-0')
    expect(markup).toContain('data-edge-fade="top"')
    expect(markup).toContain('data-edge-fade="bottom"')
    expect(markup).not.toContain('blur(')
  })
  it('maps fixed slots and fades both ends only when more history exists', () => {
    expect(railScrollWindow(30, 28, 0, 840, 280)).toEqual({ start: 0, moreAbove: false, moreBelow: true })
    expect(railScrollWindow(30, 28, 280, 840, 280)).toEqual({ start: 10, moreAbove: true, moreBelow: true })
    expect(railScrollWindow(30, 28, 560, 840, 280)).toEqual({ start: 20, moreAbove: true, moreBelow: false })
    expect(railScrollWindow(9, 28, 0, 252, 252)).toEqual({ start: 0, moreAbove: false, moreBelow: false })
    expect(railScrollWindow(30, 28, 565, 840, 280).start).toBe(20)
  })
  it('aligns a stopped scroll to a real row without exceeding either end', () => {
    expect(railAlignedOffset(13, 28, 560)).toBe(0)
    expect(railAlignedOffset(45, 28, 560)).toBe(56)
    expect(railAlignedOffset(567, 28, 560)).toBe(560)
    expect(railAlignedOffset(1530, 27.8, 1529)).toBe(1529)
    expect(railAlignedOffset(0, 0, 0)).toBe(0)
  })
  it('shows recent ten turns by default and includes an older reading position', () => {
    expect(railWindowStart(9, 8)).toBe(0)
    expect(railWindowStart(100, 99)).toBe(90)
    expect(railWindowStart(100, 50)).toBe(46)
    expect(railWindowStart(100, 0)).toBe(0)
  })
})
