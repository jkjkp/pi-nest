import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TurnNavigationRail } from './turn-navigation-rail.js'
import { nextOutlineAutoFollow } from './turn-navigation-rail-state.js'

describe('TurnNavigationRail', () => {
  it('keeps every long-session Turn as an independent rail marker and outline entry', () => {
    const entries = Array.from({ length: 37 }, (_, index) => ({
      id: `turn-${index + 1}`,
      index: index + 1,
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
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />)

    expect((markup.match(/aria-current="location"/g) ?? [])).toHaveLength(2)
    expect(markup).toContain('bg-primary')
  })

  it('centers a short minimap while keeping the interactive rail narrower than its gutter', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />)

    expect(markup).toContain('class="hidden h-[min(58vh,28rem)] w-full shrink-0')
    expect(markup).toContain('md:top-1/2')
    expect(markup).toContain('md:-translate-y-1/2')
    expect(markup).toContain('relative grid h-full w-full place-items-center')
    expect(markup).toContain('group relative h-full w-5')
    expect(markup).toContain('data-timeline-rail=""')
    expect(markup).toContain('absolute left-full top-1/2')
  })

  it('starts collapsed and leaves outline controls out of the tab order until rail click opens it', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />)

    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('pointer-events-none opacity-0')
    expect(markup).toContain('tabindex="-1"')
    expect(markup).not.toContain('onPointerEnter')
  })

  it('contains scroll chaining within the history outline', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />)

    expect(markup).toContain('overflow-y-auto overscroll-contain')
  })

  it('skips auto-follow until a clicked target becomes current', () => {
    expect(nextOutlineAutoFollow('turn-4', 'turn-2')).toEqual({ pendingUserJumpTurnId: 'turn-4', shouldFollow: false })
    expect(nextOutlineAutoFollow('turn-4', 'turn-4')).toEqual({ pendingUserJumpTurnId: undefined, shouldFollow: false })
    expect(nextOutlineAutoFollow(undefined, 'turn-5')).toEqual({ pendingUserJumpTurnId: undefined, shouldFollow: true })
  })
})
