import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AssistantMarkdown } from './assistant-markdown.js'
import { MermaidDiagram } from './mermaid-diagram.js'

describe('AssistantMarkdown', () => {
  it('memoizes unchanged completed Markdown', () => {
    expect(AssistantMarkdown).toMatchObject({ $$typeof: Symbol.for('react.memo') })
  })

  it('renders semantic Markdown without allowing raw HTML', () => {
    const markup = renderToStaticMarkup(<AssistantMarkdown isStreaming={false} source={'# Heading\n\n**bold** and `code` and *plain emphasis*\n\n- one\n- two\n\n| key | value |\n| --- | --- |\n| a | b |\n\n[link](https://example.com)\n\n<script>alert(1)</script>'} />)

    expect(markup).toContain('<strong')
    expect(markup).toContain('<code')
    expect(markup).toContain('<ul')
    expect(markup).toContain('<table')
    expect(markup).toContain('href="https://example.com"')
    expect(markup).toContain('<h1')
    expect(markup).toContain('<em')
    expect(markup).not.toContain('<script')
  })

  it('keeps Mermaid source as code during a streaming turn and creates a preview after it settles', () => {
    const source = '```mermaid\nflowchart TD\n  A --> B\n```'

    expect(renderToStaticMarkup(<AssistantMarkdown isStreaming source={source} />)).toContain('flowchart TD')
    expect(renderToStaticMarkup(<AssistantMarkdown isStreaming={false} source={source} />)).toContain('正在生成 Mermaid 图表')
  })

  it.each([true, false])('renders multi-paragraph and nested quotes with supported inline content (streaming: %s)', (isStreaming) => {
    const source = '> first **bold** [link](https://example.com)\n>\n> second paragraph\n>\n> > nested quote\n>\n> - quoted item\n\noutside quote'
    const markup = renderToStaticMarkup(<AssistantMarkdown isStreaming={isStreaming} source={source} />)

    expect(markup.match(/<blockquote\b/g)).toHaveLength(2)
    expect(markup).toContain('second paragraph</p>')
    expect(markup).toContain('nested quote</p>')
    expect(markup).toContain('<strong')
    expect(markup).toContain('href="https://example.com"')
    expect(markup).toContain('<li>quoted item</li>')
    expect(markup.lastIndexOf('</blockquote>')).toBeLessThan(markup.indexOf('outside quote'))
  })

  it('keeps greater-than signs in code and escaped text out of quote blocks', () => {
    const source = '`> inline code`\n\n```text\n> code block\n```\n\n\\> escaped text'
    const markup = renderToStaticMarkup(<AssistantMarkdown isStreaming={false} source={source} />)

    expect(markup).not.toContain('<blockquote')
    expect(markup).toContain('&gt; inline code')
    expect(markup).toContain('&gt; code block')
    expect(markup).toContain('&gt; escaped text')
  })

  it('allows only safe outbound link protocols and rejects oversized Mermaid source', () => {
    const markup = renderToStaticMarkup(<AssistantMarkdown isStreaming={false} source={'[web](https://example.com) [mail](mailto:test@example.com) [bad](javascript:alert(1)) [local](/local)'} />)

    expect(markup).toContain('href="https://example.com"')
    expect(markup).toContain('href="mailto:test@example.com"')
    expect(markup).not.toContain('javascript:')
    expect(markup).not.toContain('href="/local"')
    expect(renderToStaticMarkup(<MermaidDiagram source={'x'.repeat(32 * 1024 + 1)} />)).toContain('图表源码超过 32 KiB 上限。')
  })
})

it('renders heading levels, deletion, rules and read-only task checkboxes', () => {
  const source = '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\n~~removed~~\n\n---\n\n- [x] done\n- [ ] pending'
  const markup = renderToStaticMarkup(<AssistantMarkdown isStreaming={false} source={source} />)
  for (let level = 1; level <= 6; level++) expect(markup).toContain(`<h${level}`)
  expect(markup).toContain('<del')
  expect(markup).toContain('<hr')
  expect(markup.match(/type="checkbox"/g)).toHaveLength(2)
  expect(markup.match(/disabled=""/g)).toHaveLength(2)
  expect(markup).toContain('checked=""')
  expect(markup).toContain('contains-task-list')
})

it('distinguishes inline code from fenced and indented blocks while escaping code HTML', () => {
  const source = '`inline`\n\n```\n  <script>alert(1)</script>\n\n```\n\n    indented\n\n```js\nconst x = 1\n```'
  const markup = renderToStaticMarkup(<AssistantMarkdown isStreaming={false} source={source} />)
  expect(markup.match(/data-markdown-code-block=""/g)).toHaveLength(3)
  expect(markup.match(/aria-label="复制代码"/g)).toHaveLength(3)
  expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(markup).toContain('  &lt;script&gt;alert(1)&lt;/script&gt;\n')
  expect(markup).not.toContain('<script>')
  expect(markup).toContain('>文本</span>')
  expect(markup).toContain('>js</span>')
})
