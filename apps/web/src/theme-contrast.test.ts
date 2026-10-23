import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
const dark = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}/)![1]!
const colors = Object.fromEntries([...dark.matchAll(/--([\w-]+): ([^;]+);/g)].map((match) => [match[1]!, match[2]!]))
function color(name: string): string {
  const value = colors[name]!
  const alias = value.match(/^var\(--([\w-]+)\)$/)?.[1]
  return alias ? color(alias) : value
}
function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map((channel) => {
    const value = parseInt(channel, 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}
function contrast(foreground: string, background: string) {
  const a = luminance(color(foreground)), b = luminance(color(background))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

it('keeps dark text readable on normal, elevated and selected surfaces', () => {
  for (const background of ['background', 'card', 'popover', 'muted', 'secondary', 'accent']) {
    for (const foreground of ['foreground', 'muted-foreground', 'link', 'destructive', 'success', 'warning']) {
      expect(contrast(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5)
    }
  }
  expect(contrast('primary-foreground', 'primary')).toBeGreaterThanOrEqual(4.5)
  expect(luminance(color('foreground'))).toBeLessThan(luminance('#e0e0e0'))
})

it('keeps every dark syntax token readable on the code background', () => {
  for (const token of Object.keys(colors).filter((name) => name.startsWith('shiki-token-'))) {
    expect(contrast(token, 'code-background'), token).toBeGreaterThanOrEqual(4.5)
  }
})
