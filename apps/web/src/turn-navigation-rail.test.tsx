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

  it('keeps its collapsed width inside the gutter and opens the outline from its right edge', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />)

    expect(markup).toContain('class="hidden h-[min(62vh,32rem)] w-full shrink-0')
    expect(markup).toContain('relative grid h-full w-full place-items-center')
    expect(markup).toContain('absolute inset-y-0 w-px justify-self-center bg-border')
    expect(markup).toContain('justify-self-center -translate-y-1/2 place-items-center')
    expect(markup).toContain('absolute left-full top-0')
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
