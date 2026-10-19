import { afterEach, describe, expect, it, vi } from 'vitest'

import { resizeComposerTextarea } from './composer-textarea.js'

const computedStyle = {
  borderBottomWidth: '1px',
  borderTopWidth: '1px',
  lineHeight: '28px',
  paddingBottom: '4px',
  paddingTop: '4px',
} as CSSStyleDeclaration

describe('resizeComposerTextarea', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('accounts for padding and borders, caps overflow, then shrinks again', () => {
    vi.stubGlobal('getComputedStyle', () => computedStyle)
    const textarea = {
      scrollTop: 0,
      scrollHeight: 36,
      style: { height: '', overflowY: '' },
    }

    resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement, 196)
    expect(textarea.style).toMatchObject({ height: '38px', overflowY: 'hidden' })

    textarea.scrollHeight = 64
    resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement, 196)
    expect(textarea.style).toMatchObject({ height: '66px', overflowY: 'hidden' })

    textarea.scrollHeight = 240
    resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement, 196)
    expect(textarea.style).toMatchObject({ height: '196px', overflowY: 'auto' })

    textarea.scrollHeight = 36
    resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement, 196)
    expect(textarea.style).toMatchObject({ height: '38px', overflowY: 'hidden' })
  })

  it.each([0, 120, 924])('preserves scroll position %s when auto height resets the viewport', (scrollTop) => {
    vi.stubGlobal('getComputedStyle', () => computedStyle)
    let height = '196px'
    const textarea = {
      scrollTop,
      scrollHeight: 1120,
      style: {
        get height() { return height },
        set height(value: string) {
          height = value
          if (value === 'auto') textarea.scrollTop = 0
        },
        overflowY: 'auto',
      },
    }

    resizeComposerTextarea(textarea as unknown as HTMLTextAreaElement)

    expect(textarea.scrollTop).toBe(scrollTop)
    expect(textarea.style.height).toBe('196px')
    expect(textarea.style.overflowY).toBe('auto')
  })

})
