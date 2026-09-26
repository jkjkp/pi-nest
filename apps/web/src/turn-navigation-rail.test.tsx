import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TurnNavigationRail } from './turn-navigation-rail.js'
import { jumpFromMarker, jumpFromOutline, markerHitHeight, nextOutlineAutoFollow, openOutlineFromContextMenu, railHeight } from './turn-navigation-rail-state.js'

describe('TurnNavigationRail', () => {
  it('keeps every long-session Turn as an independent rail marker and outline entry', () => {
    const entries = Array.from({ length: 37 }, (_, index) => ({
      id: `turn-${index + 1}`,
      index: index + 1,
      prompt: `prompt ${index + 1}`,
      promptPreview: `prompt ${index + 1}`,
      startedAt: '2026-09-24T00:00:00.000Z',
    }))
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={entries} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />)

    expect((markup.match(/data-timeline-marker=""/g) ?? [])).toHaveLength(37)
    expect((markup.match(/data-turn-outline-id=/g) ?? [])).toHaveLength(37)
    expect(markup).toContain('aria-label="第 37 轮：prompt 37"')
    expect(markup).not.toContain('第 1–2 轮')
  })

  it('marks the initial current Turn in both rail and outline', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, prompt: 'question', promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />)

    expect((markup.match(/aria-current="location"/g) ?? [])).toHaveLength(2)
    expect(markup).toContain('bg-primary')
  })

  it('centers a compact minimap while keeping the interactive rail narrower than its gutter', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, prompt: 'question', promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />)

    expect(markup).toContain('style="height:min(120px, 42vh)"')
    expect(markup).toContain('md:absolute md:left-0 md:top-1/2')
    expect(markup).toContain('md:-translate-y-1/2')
    expect(markup).not.toContain('md:sticky')
    expect(markup).toContain('relative grid h-full w-full place-items-center')
    expect(markup).toContain('relative h-full w-5')
    expect(markup).toContain('data-timeline-rail=""')
    expect(markup).toContain('absolute left-full top-1/2')
  })

  it('starts collapsed, does not show hover text, and leaves outline controls out of the tab order', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, prompt: 'full user message', promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />)

    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('pointer-events-none opacity-0')
    expect(markup).toContain('tabindex="-1"')
    expect(markup).not.toContain('onPointerEnter')
    expect(markup).not.toContain('title=')
  })

  it('contains scroll chaining within the history outline', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, prompt: 'first line\nsecond line\nthird line\nfourth line', promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />)

    expect(markup).toContain('overflow-y-auto overscroll-contain')
    expect(markup).toContain('line-clamp-3')
    expect(markup).toContain('first line\nsecond line\nthird line\nfourth line')
    expect(markup).toContain('第 1 轮')
    expect(markup).toContain('w-[23rem]')
    expect(markup).toContain('max-h-[min(60vh,26.25rem)]')
  })

  it('skips auto-follow until a clicked target becomes current', () => {
    expect(nextOutlineAutoFollow('turn-4', 'turn-2')).toEqual({ pendingUserJumpTurnId: 'turn-4', shouldFollow: false })
    expect(nextOutlineAutoFollow('turn-4', 'turn-4')).toEqual({ pendingUserJumpTurnId: undefined, shouldFollow: false })
    expect(nextOutlineAutoFollow(undefined, 'turn-5')).toEqual({ pendingUserJumpTurnId: undefined, shouldFollow: true })
  })

  it('uses left clicks only for Turn jumps, and closes the outline after its own jump', () => {
    const jumped: string[] = []
    let closed = 0
    jumpFromMarker((turnId) => jumped.push(turnId), 'turn-2')
    expect(jumped).toEqual(['turn-2'])
    expect(closed).toBe(0)

    jumpFromOutline((turnId) => jumped.push(turnId), () => { closed += 1 }, 'turn-3')
    expect(jumped).toEqual(['turn-2', 'turn-3'])
    expect(closed).toBe(1)
  })

  it('opens the one history outline only from a context-menu action and suppresses the browser menu', () => {
    let prevented = 0
    let opened = 0
    openOutlineFromContextMenu({ preventDefault: () => { prevented += 1 } }, () => { opened += 1 })
    expect(prevented).toBe(1)
    expect(opened).toBe(1)
  })

  it('keeps short rails compact, caps long rails, and gives long-session markers non-overlapping vertical hit areas', () => {
    expect(railHeight(1)).toBe(120)
    expect(railHeight(37)).toBe(360)
    expect(railHeight(200)).toBe(360)
    expect(markerHitHeight(37)).toBeLessThan(railHeight(37) / 36)
  })
})
