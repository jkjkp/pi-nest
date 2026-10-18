import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AssistantMarkdown } from './assistant-markdown.js'
import { MermaidDiagram } from './mermaid-diagram.js'

describe('AssistantMarkdown', () => {
  it('memoizes unchanged completed Markdown', () => {
    expect(AssistantMarkdown).toMatchObject({ $$typeof: Symbol.for('react.memo') })
  })

  it('renders only the supported Markdown reading primitives', () => {
    const markup = renderToStaticMarkup(<AssistantMarkdown isStreaming={false} source={'# Heading\n\n**bold** and `code` and *plain emphasis*\n\n- one\n- two\n\n| key | value |\n| --- | --- |\n| a | b |\n\n[link](https://example.com)\n\n<script>alert(1)</script>'} />)

    expect(markup).toContain('<strong')
    expect(markup).toContain('<code')
    expect(markup).toContain('<ul')
    expect(markup).toContain('<table')
    expect(markup).toContain('href="https://example.com"')
    expect(markup).not.toContain('<h1')
    expect(markup).not.toContain('<em')
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
