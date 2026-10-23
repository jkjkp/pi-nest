import { expect, it } from 'vitest'
import { highlightCode } from './code-highlight.js'

it('highlights supported languages and aliases without changing source text', async () => {
  const samples = {
    js: 'const x = "<script>"\n\n', ts: 'const x: number = 1', jsx: '<div>Hello</div>', tsx: 'const x = <div />',
    json: '{"a": true}', sh: 'echo "$HOME"', py: 'def hello():\n  return 1', html: '<div>Hello</div>',
    css: 'body { color: red; }', sql: 'SELECT * FROM users;', yml: 'a: true', md: '# Hello', diff: '+added\n-removed',
  }
  for (const [language, code] of Object.entries(samples)) {
    const tokens = await highlightCode(code, language)
    expect(tokens?.flat().some((token) => token.color || token.htmlStyle)).toBe(true)
    expect(tokens?.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code)
  }
  expect(await highlightCode('raw', 'unknown-language')).toBeUndefined()
  expect(await highlightCode('raw', '__proto__')).toBeUndefined()
})


it('uses theme variables for dark syntax colors while retaining the light palette', async () => {
  const tokens = (await highlightCode('// note\nconst value = "hello"', 'ts'))!.flat()
  expect(tokens.every((token) => String(token.color ?? token.htmlStyle?.color).startsWith('#'))).toBe(true)
  const darkStyles = tokens.map((token) => String(token.htmlStyle?.['--shiki-dark']))
  expect(darkStyles).toContain('var(--shiki-token-comment)')
  expect(darkStyles).toContain('var(--shiki-token-keyword)')
  expect(darkStyles).toContain('var(--shiki-token-string-expression)')
})
