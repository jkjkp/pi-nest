import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'

import { TurnNavigationRail } from './turn-navigation-rail.js'

describe('TurnNavigationRail', () => {
  it('keeps long-session navigation bounded to 36 contiguous marker ranges', () => {
    const entries = Array.from({ length: 37 }, (_, index) => ({
      id: `turn-${index + 1}`,
      index: index + 1,
      promptPreview: `prompt ${index + 1}`,
      startedAt: '2026-09-24T00:00:00.000Z',
    }))
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <TurnNavigationRail entries={entries} onJump={() => undefined} scrollViewport={null} timelineRoot={createRef<HTMLElement>()} />
      </TooltipProvider>,
    )

    expect((markup.match(/aria-label="第 /g) ?? [])).toHaveLength(19)
    expect(markup).toContain('aria-label="第 1–2 轮：prompt 1"')
    expect(markup).toContain('aria-label="第 37 轮：prompt 37"')
  })
})
