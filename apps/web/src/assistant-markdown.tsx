import { Children, isValidElement, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { MermaidDiagram } from './mermaid-diagram.js'

const allowedElements = ['a', 'br', 'code', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']

function safeUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? value : undefined
  } catch {
    return undefined
  }
}

function language(className: string | undefined) {
  return className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase()
}

function MarkdownPre({ children, node: _node, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
  const child = Children.count(children) === 1 ? Children.only(children) : undefined
  if (isValidElement<{ className?: string }>(child) && language(child.props.className) === 'mermaid') return <>{children}</>
  return <pre className="my-3 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs leading-6" {...props}>{children}</pre>
}

function MarkdownCode({ children, className, isStreaming, node: _node, ...props }: ComponentProps<'code'> & { isStreaming: boolean; node?: unknown }) {
  const value = String(children).replace(/\n$/, '')
  if (language(className) === 'mermaid') {
    if (isStreaming) return <pre className="my-3 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs leading-6"><code className={className} {...props}>{children}</code></pre>
    return <MermaidDiagram source={value} />
  }
  return <code className={className ? className : 'rounded bg-muted px-1 py-0.5 text-[0.9em]'} {...props}>{children}</code>
}

function MarkdownLink({ children, href }: ComponentProps<'a'>) {
  const url = href ? safeUrl(href) : undefined
  return url ? <a className="text-primary underline underline-offset-4" href={url} rel="noopener noreferrer" target="_blank">{children}</a> : <>{children}</>
}

function markdownComponents(isStreaming: boolean): Components {
  return {
    a: MarkdownLink,
    code: (props) => <MarkdownCode {...props} isStreaming={isStreaming} />,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>,
    p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
    pre: MarkdownPre,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    table: ({ children }) => <div className="my-3 overflow-x-auto rounded-md border"><table className="w-full border-collapse text-sm">{children}</table></div>,
    td: ({ children }) => <td className="border-t px-3 py-2 align-top">{children}</td>,
    th: ({ children }) => <th className="border-b bg-muted/60 px-3 py-2 text-left font-semibold">{children}</th>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>,
  }
}

export function AssistantMarkdown({ isStreaming, source }: { isStreaming: boolean; source: string }) {
  return (
    <ReactMarkdown allowedElements={allowedElements} components={markdownComponents(isStreaming)} remarkPlugins={[remarkGfm]} skipHtml unwrapDisallowed urlTransform={safeUrl}>
      {source}
    </ReactMarkdown>
  )
}
