import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IncrementalMarkdownParser, hasDefinitions } from './markdown-incremental.js'
import { allowedElements, markdownUrl, parseMarkdown, renderMarkdown } from './markdown-pipeline.js'
import { AssistantMarkdown, markdownComponents } from './assistant-markdown.js'
import { boundaryMarkdown, prefixes, streamingFixtures } from '../perf/markdown-fixtures.js'

const html = (root: ReturnType<typeof parseMarkdown>) => renderToStaticMarkup(renderMarkdown(root, markdownComponents, false))
const projected = (result: ReturnType<IncrementalMarkdownParser['update']>) => result.root ?? { type: 'root' as const, children: [...result.frozen, ...result.tail].map(({ node }) => node) }
const withoutPositions = (value: unknown) => JSON.parse(JSON.stringify(value, (key, entry) => key === 'position' ? undefined : entry))

describe('incremental Markdown', () => {
  it.each([1, 7, 32, 256])('matches a full grammar at every prefix, chunk=%s', (chunk) => {
    const parser = new IncrementalMarkdownParser(parseMarkdown)
    for (const text of prefixes(boundaryMarkdown, chunk)) {
      const result = parser.update(text)
      expect(withoutPositions(projected(result))).toEqual(withoutPositions(parseMarkdown(text)))
      expect(html(projected(result))).toBe(html(parseMarkdown(text)))
    }
  })

  it('matches full parsing with fixed-seed irregular chunks and container fences', () => {
    const source = boundaryMarkdown + '\n\n> ```ts\n> const x = 1\n> ```\n\n- item\n\n  ~~~\n  nested code\n  ~~~\n\nafter'
    const parser = new IncrementalMarkdownParser(parseMarkdown)
    let seed = 47
    for (let end = 0; end < source.length;) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      end = Math.min(source.length, end + 1 + seed % 31)
      const text = source.slice(0, end)
      expect(withoutPositions(projected(parser.update(text)))).toEqual(withoutPositions(parseMarkdown(text)))
    }
  })

  it.each([
    '[a][ref]\n\none\n\ntwo\n\nthree\n\n[ref]: https://example.com\n\n[ref]',
    '[ref]: https://example.com\n\none\n\ntwo\n\nthree\n\n[a][ref]',
    'note[^n]\n\none\n\ntwo\n\nthree\n\n[^n]: body\n\nnext[^n]',
    '> [ref]: https://example.com\n\none\n\n[a][ref]',
    '[only]: https://example.com\n\n',
  ])('keeps document-wide definitions correct across frozen boundaries: %s', (source) => {
    const parser = new IncrementalMarkdownParser(parseMarkdown)
    for (const text of prefixes(source, 1)) expect(html(projected(parser.update(text)))).toBe(html(parseMarkdown(text)))
    expect(parser.update(source).root).toBeDefined()
  })

  it.each(['\n', '\r\n', '\r'])('extends open fences with exact whitespace and positions, newline=%j', (newline) => {
    for (const opening of ['```ts', '  ~~~~text']) {
      const source = ['first', '', opening, '  😀 one', '', 'two', opening.includes('~') ? '   ~~~~~' : '```', '', 'after', '', 'tail'].join(newline)
      const parser = new IncrementalMarkdownParser(parseMarkdown)
      for (const text of prefixes(source, 1)) expect(withoutPositions(projected(parser.update(text)))).toEqual(withoutPositions(parseMarkdown(text)))
    }
  })

  it('uses stable absolute keys, freezes nodes once and resets all state on replacement', () => {
    const parser = new IncrementalMarkdownParser(parseMarkdown)
    const initial = '😀 first\n\nsecond\n\nthird'
    const before = parser.update(initial)
    const first = before.frozen[0]!
    const after = parser.update(initial + '\n\nfourth\n\nfifth')
    expect(after.frozen[0]).toBe(first)
    expect([...after.frozen, ...after.tail].map(({ key }) => key)).toEqual(parseMarkdown(initial + '\n\nfourth\n\nfifth').children.map((node) => node.position!.start.offset))
    expect(parser.update(initial + '\n\nfourth\n\nfifth')).toBe(after)
    for (const source of ['other', '', '```\nnew', 'same length', '[ref]: https://example.com', 'reset']) {
      expect(withoutPositions(projected(parser.update(source)))).toEqual(withoutPositions(parseMarkdown(source)))
    }
    expect(parser.update('reset').root).toBeUndefined()
  })

  it('counts code columns in UTF-16 units, including astral characters and split surrogate pairs', () => {
    for (const chunk of [1, 7]) {
      const parser = new IncrementalMarkdownParser(parseMarkdown)
      for (const source of prefixes('```ts\r\none\r\n😀😀 two\r\nlast 😀', chunk)) {
        expect(projected(parser.update(source)).children).toEqual(parseMarkdown(source).children)
      }
    }
  })

  it('keeps positionless grammars in the tail', () => {
    const parser = new IncrementalMarkdownParser((text) => withoutPositions(parseMarkdown(text)))
    expect(parser.update('one\n\ntwo\n\nthree\n\nfour').frozen).toHaveLength(0)
  })

  it.each(['mixed', 'fence'] as const)('reduces grammar input by at least 70%% for %s', (name) => {
    const work: number[] = []
    for (const size of [10_000, 20_000]) {
      const source = streamingFixtures(size)[name]
      let units = 0
      const parser = new IncrementalMarkdownParser((text) => { units += text.length; return parseMarkdown(text) })
      let baseline = 0
      for (const text of prefixes(source, 128)) { baseline += text.length; parser.update(text) }
      expect(units / baseline).toBeLessThan(0.3)
      const previous = units
      parser.update(source)
      expect(units).toBe(previous)
      work.push(units)
    }
    expect(work[1]! / work[0]!).toBeLessThan(2.5)
  })
})

describe('shared pipeline compatibility', () => {
  it.each([boundaryMarkdown, '[ref]: https://example.com\n\n[a][ref]', 'note[^n]\n\n[^n]: body', '<b>inline</b>\n\n<div>block</div>\n\nend', '![alt](https://example.com/a.png)\n\n[unsafe](javascript:alert(1)) [relative](//evil.test)'])('matches the previous ReactMarkdown renderer: %s', (source) => {
    const expected = renderToStaticMarkup(<ReactMarkdown allowedElements={allowedElements} components={markdownComponents} remarkPlugins={[remarkGfm]} skipHtml unwrapDisallowed urlTransform={(url) => markdownUrl(url, false)}>{source}</ReactMarkdown>)
    expect(html(parseMarkdown(source))).toBe(expected)
    const actual = renderToStaticMarkup(<AssistantMarkdown source={source} isStreaming={false} />)
    expect(actual).toContain(expected)
    expect(hasDefinitions(parseMarkdown(source))).toBe(Boolean(new IncrementalMarkdownParser(parseMarkdown).update(source).root))
  })
})
