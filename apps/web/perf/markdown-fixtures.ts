export const boundaryMarkdown = [
  '# 中文标题 😀', '', 'Text **bold** *em* ~~del~~ `inline` &amp; \\> escaped.', '',
  '- [x] done', '- [ ] pending', '', '  continuation', '',
  '> quote', '>', '> - nested', '>   lazy', '',
  'Setext', '===', '', '| a | b |', '| --- | :---: |', '| 1 | 2 |', '',
  '```ts', 'const value = "> not html"', '', '```', '',
  '    indented', '', '---', '', '[safe](https://example.com) [local](src/a.ts#L2)', '',
  '<script>unsafe()</script>', '', 'after', '', 'tail',
].join('\n')

export function streamingFixtures(size = 50_000) {
  const mixed = '# Section\n\n中文 😀 **bold** [web](https://example.com)\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\n'
  const repeat = (text: string) => text.repeat(Math.ceil(size / text.length))
  return {
    mixed: repeat(mixed),
    fence: '```ts\n' + repeat('const greeting = "中文 😀";\n'),
    paragraph: repeat('中文 😀 plain text '),
    list: repeat('- item **bold**\n'),
    table: '| a | b |\n| --- | --- |\n' + repeat('| 1 | 2 |\n'),
    references: '[link][ref]\n\n[ref]: https://example.com\n\n' + repeat(mixed),
  }
}

export function prefixes(source: string, chunk: number) {
  const values: string[] = []
  for (let end = chunk; end < source.length; end += chunk) values.push(source.slice(0, end))
  values.push(source)
  return values
}
