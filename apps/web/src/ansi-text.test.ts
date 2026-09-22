import { describe, expect, it } from 'vitest'

import { stripAnsiLine, stripAnsiText } from './ansi-text.js'

describe('ANSI text cleanup', () => {
  it('drops the color codes an extension writes around its status text', () => {
    const status = '\u001b[38;2;102;102;102m○\u001b[39m 🐴 \u001b[38;2;128;128;128mponytail: \u001b[39m\u001b[38;2;212;212;212m⚡ FULL\u001b[39m'

    expect(stripAnsiLine(status)).toBe('○ 🐴 ponytail: ⚡ FULL')
  })

  it('collapses the whitespace an extension uses to pad a line', () => {
    expect(stripAnsiLine('  ponytail:\n\n   ⚡ FULL  ')).toBe('ponytail: ⚡ FULL')
  })

  it('keeps line breaks for multi-line editor text', () => {
    expect(stripAnsiText('first\u001b[0m\nsecond')).toBe('first\nsecond')
  })

  it('removes operating system command sequences and leaves plain text alone', () => {
    expect(stripAnsiLine('\u001b]0;pi-nest\u0007ready')).toBe('ready')
    expect(stripAnsiLine('工具：已禁用')).toBe('工具：已禁用')
  })
})
