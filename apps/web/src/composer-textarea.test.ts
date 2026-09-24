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
})
