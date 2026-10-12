import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TurnNavigationRail } from './turn-navigation-rail.js'
import { railWindowStart } from './turn-navigation-rail-state.js'

const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `turn-${index + 1}`, index: index + 1, promptPreview: `prompt ${index + 1}`, startedAt: '2026-09-24T00:00:00.000Z' }))

describe('ten-node conversation navigation', () => {
  it.each([0, 1, 9, 10, 11, 3000])('bounds visible markers for %i turns without mounting closed history', (count) => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={entries(count)} onJump={() => undefined} />)
    expect((markup.match(/data-rail-marker=""/g) ?? []).length).toBe(Math.min(10, count))
    expect(markup).not.toContain('data-turn-outline-id')
    expect(markup).not.toContain('<svg')
  })
  it('highlights the current user turn and keeps the navigation on the right', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail activeTurnId="turn-51" entries={entries(100)} onJump={() => undefined} />)
    expect(markup).toContain('data-active-turn-marker="turn-51"')
    expect(markup).toContain('absolute right-0')
    expect(markup).toContain('blur(0.5px)')
  })
  it('shows recent ten turns by default and includes an older reading position', () => {
    expect(railWindowStart(9, 8)).toBe(0)
    expect(railWindowStart(100, 99)).toBe(90)
    expect(railWindowStart(100, 50)).toBe(46)
    expect(railWindowStart(100, 0)).toBe(0)
  })
})
