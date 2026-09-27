import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TurnNavigationRail } from './turn-navigation-rail.js'
import { computeIdleRailViewportLayout, computeOutlineViewportLayout, computeRailViewportLayout, densityBins, focusWindow, jumpFromMarker, jumpFromOutline, nextOutlineAutoFollow, nextRailIndex, openOutlineFromContextMenu, railExpandedMaxHeight, railIdleHeight, railIndexFromPointer, railMode, turnRatio } from './turn-navigation-rail-state.js'

describe('TurnNavigationRail', () => {
  it('uses bounded density and focus SVG elements for long sessions without mounting a closed outline', () => {
    const entries = Array.from({ length: 3_000 }, (_, index) => ({
      id: `turn-${index + 1}`,
      index: index + 1,
      promptPreview: `prompt ${index + 1}`,
      startedAt: '2026-09-24T00:00:00.000Z',
    }))
    const markup = renderToStaticMarkup(<TurnNavigationRail activeTurnId="turn-1501" entries={entries} onJump={() => undefined} />)

    expect((markup.match(/data-timeline-marker=""/g) ?? [])).toHaveLength(0)
    expect((markup.match(/data-rail-density-bin=""/g) ?? [])).toHaveLength(64)
    expect((markup.match(/data-rail-focus-marker=""/g) ?? [])).toHaveLength(8)
    expect((markup.match(/<path/g) ?? []).length).toBeLessThan(80)
    expect((markup.match(/data-turn-outline-id=/g) ?? [])).toHaveLength(0)
    expect(markup).toContain('对话轮次导航，共 3000 轮')
  })

  it('marks the initial current Turn in the rail', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} />)

    expect(markup).toContain('data-active-turn-marker="turn-1"')
  })

  it('uses the active Turn supplied by the virtual timeline', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail activeTurnId="turn-1" entries={[
      { id: 'turn-1', index: 1, promptPreview: 'first', startedAt: '2026-09-24T00:00:00.000Z' },
      { id: 'turn-2', index: 2, promptPreview: 'second', startedAt: '2026-09-24T00:01:00.000Z' },
    ]} onJump={() => undefined} />)

    expect(markup).toContain('data-active-turn-marker="turn-1"')
  })

  it('keeps the Rail viewport-bound regardless of Turn count', () => {
    const markup = [10, 100, 1_000].map((count) => renderToStaticMarkup(<TurnNavigationRail entries={Array.from({ length: count }, (_, index) => ({ id: `turn-${index}`, index: index + 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }))} onJump={() => undefined} />))

    expect(markup.every((view) => view.includes(`height:${railIdleHeight}px`))).toBe(true)
  })

  it('centers a fixed minimap while keeping the interactive rail narrower than its gutter', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} />)

    expect(markup).toContain(`height:${railIdleHeight}px`)
    expect(markup).toContain('max-height:calc(100% - 48px)')
    expect(markup).toContain('top:50%;transform:translateY(-50%)')
    expect(markup).toContain('md:absolute md:left-0')
    expect(markup).not.toContain('md:sticky')
    expect(markup).toContain('relative grid h-full w-full place-items-center')
    expect(markup).toContain('relative h-full w-7')
    expect(markup).toContain('data-timeline-rail=""')
    expect(markup).toContain('absolute left-full z-20')
  })

  it('starts collapsed, does not show hover text, and does not mount outline controls', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} />)

    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('pointer-events-none opacity-0')
    expect(markup).not.toContain('data-turn-outline-id')
    expect(markup).not.toContain('onPointerEnter')
    expect(markup).not.toContain('title=')
  })

  it('keeps the history outline panel ready to open from its compact rail', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail entries={[{ id: 'turn-1', index: 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }]} onJump={() => undefined} />)

    expect(markup).not.toContain('overflow-y-auto overscroll-contain')
    expect(markup).toContain('w-[23rem]')
    expect(markup).toContain('transition-[height,opacity,top,transform]')
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

  it('keeps short rails compact, caps long rails, and maps pointer positions to nearby Turns', () => {
    expect(turnRatio(0, 100)).toBe(0)
    expect(turnRatio(50, 101)).toBe(0.5)
    expect(turnRatio(99, 100)).toBe(1)
    expect(railIndexFromPointer(100, { height: 200, top: 0 }, 101)).toBe(50)
    expect(railIndexFromPointer(-10, { height: 200, top: 0 }, 101)).toBe(0)
    expect(railIndexFromPointer(220, { height: 200, top: 0 }, 101)).toBe(100)
  })

  it('switches from detailed to compact to bounded density with an active focus window', () => {
    expect(railMode(40)).toBe('detailed')
    expect(railMode(41)).toBe('compact')
    expect(railMode(201)).toBe('density')
    expect(focusWindow(200, 1_000)).toEqual([196, 197, 198, 199, 200, 201, 202, 203, 204])
    expect(densityBins(3_000)).toHaveLength(64)
    expect(densityBins(3_000).reduce((total, bin) => total + bin.count, 0)).toBe(3_000)
  })

  it('clamps the Rail rect to message viewport safety insets and shrinks it for a short viewport', () => {
    const desktop = computeRailViewportLayout({ viewportHeight: 800 })
    const short = computeRailViewportLayout({ viewportHeight: 180 })
    const composerExpanded = computeRailViewportLayout({ viewportHeight: 320 })

    expect(desktop).toEqual({ bottom: 510, height: railExpandedMaxHeight, top: 290 })
    expect(desktop.top).toBeGreaterThanOrEqual(20)
    expect(desktop.bottom).toBeLessThanOrEqual(772)
    expect(short).toEqual({ bottom: 152, height: 132, top: 20 })
    expect(short.height).toBeLessThan(140)
    expect(short.bottom).toBeLessThanOrEqual(152)
    expect(composerExpanded.height).toBeLessThan(desktop.height)
  })

  it('keeps the idle Rail short and clamps the Outline separately to the message viewport', () => {
    const idle = computeIdleRailViewportLayout({ viewportHeight: 800 })
    const compressedIdle = computeIdleRailViewportLayout({ viewportHeight: 150 })
    const outlineNearBottom = computeOutlineViewportLayout({ centerY: 780, viewportHeight: 800 })

    expect(idle).toEqual({ bottom: 472, height: 144, top: 328 })
    expect(compressedIdle).toEqual({ bottom: 122, height: 102, top: 20 })
    expect(outlineNearBottom.bottom).toBe(772)
    expect(outlineNearBottom.top).toBeGreaterThanOrEqual(20)
    expect(outlineNearBottom.height).toBe(420)
  })

  it('exposes slider semantics and keyboard navigation without relying on Turn DOM', () => {
    const markup = renderToStaticMarkup(<TurnNavigationRail activeTurnId="turn-2" entries={Array.from({ length: 3 }, (_, index) => ({ id: `turn-${index + 1}`, index: index + 1, promptPreview: 'question', startedAt: '2026-09-24T00:00:00.000Z' }))} onJump={() => undefined} />)

    expect(markup).toContain('role="slider"')
    expect(markup).toContain('aria-valuemin="1"')
    expect(markup).toContain('aria-valuemax="3"')
    expect(markup).toContain('aria-valuenow="2"')
    expect(nextRailIndex('ArrowUp', 1, 3)).toBe(0)
    expect(nextRailIndex('ArrowRight', 1, 3)).toBe(2)
    expect(nextRailIndex('Home', 1, 3)).toBe(0)
    expect(nextRailIndex('End', 1, 3)).toBe(2)
  })
})
