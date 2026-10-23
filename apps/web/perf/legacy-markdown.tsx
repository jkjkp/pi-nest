// Pre-optimization renderer with matching presentation, used by regression tests and the isolated performance page.
import { Children, createContext, isValidElement, memo, useContext, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { MarkdownCodeBlock } from '../src/markdown-code-block.js'
import { MermaidDiagram } from '../src/mermaid-diagram.js'

const allowedElements = ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'input', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']

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

const LocalLinkContext = createContext<((href: string) => void) | undefined>(undefined)

const StreamingContext = createContext(false)

function MarkdownPre({ children }: ComponentProps<'pre'>) {
  const isStreaming = useContext(StreamingContext)
  const child = Children.count(children) === 1 ? Children.only(children) : undefined
  if (!isValidElement<{ children?: string; className?: string }>(child)) return <pre>{children}</pre>
  // The Markdown renderer appends one newline to block code, outside the authored source.
  const code = String(child.props.children ?? '').replace(/\n$/, '')
  const lang = language(child.props.className)
  if (lang === 'mermaid') return isStreaming
    ? <pre className="my-4 max-h-96 overflow-auto rounded-md bg-code-background p-3 font-mono text-[13px] leading-[22px]"><code>{code}</code></pre>
    : <MermaidDiagram source={code} />
  return <MarkdownCodeBlock code={code} language={lang} isStreaming={isStreaming} />
}

function MarkdownLink({ children, href }: ComponentProps<'a'>) {
  const openLocalLink = useContext(LocalLinkContext)
  const url = href ? safeUrl(href) : undefined
  if (!url && href && openLocalLink) return <button type="button" className="text-link underline underline-offset-4 text-left" onClick={() => openLocalLink(href)}>{children}</button>
  return url ? <a className="text-link underline underline-offset-4" href={url} rel="noopener noreferrer" target="_blank">{children}</a> : <>{children}</>
}

const markdownComponents: Components = {
  a: MarkdownLink,
  blockquote: ({ children }) => <blockquote className="my-4 border-l-2 border-border pl-4 text-muted-foreground">{children}</blockquote>,
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0 text-[0.9em]">{children}</code>,
  h1: ({ children }) => <h1 className="mt-6 mb-4 text-[22px] leading-normal font-normal first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-6 mb-4 text-xl leading-normal font-normal first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-5 mb-3 text-lg leading-normal font-normal first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-2 text-base font-normal first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-4 mb-2 text-[15px] font-normal first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-3 mb-2 text-sm font-normal text-muted-foreground first:mt-0">{children}</h6>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through">{children}</del>,
  hr: () => <hr className="my-5 border-t" />,
  input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled aria-label={checked ? '已完成' : '未完成'} className="mr-2 align-middle" />,
  ol: ({ children }) => <ol className="my-4 list-decimal space-y-1.5 pl-6">{children}</ol>,
  p: ({ children }) => <p className="my-4 first:mt-0 last:mb-0">{children}</p>,
  pre: MarkdownPre,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  table: ({ children }) => <div className="my-4 overflow-x-auto rounded-md border"><table className="w-full border-collapse text-sm leading-6">{children}</table></div>,
  td: ({ children }) => <td className="border-t px-3 py-2 align-top">{children}</td>,
  th: ({ children }) => <th className="border-b bg-muted/60 px-3 py-2 text-left font-normal">{children}</th>,
  ul: ({ children, className }) => <ul className={`my-4 list-disc space-y-1.5 pl-6 ${className ?? ''}`}>{children}</ul>,
}

export const LegacyMarkdown = memo(function LegacyMarkdown({ isStreaming, source, onOpenLocalLink }: { isStreaming: boolean; source: string; onOpenLocalLink?: (href: string) => void }) {
  return (
    <LocalLinkContext value={onOpenLocalLink}><StreamingContext.Provider value={isStreaming}>
      <div className="min-w-0 text-[15px] leading-[26px] font-normal [overflow-wrap:anywhere] [&_li>p]:my-2 [&_li>:first-child]:mt-0 [&_li>:last-child]:mb-0 [&_.contains-task-list]:list-none [&_.contains-task-list]:pl-2">
        <ReactMarkdown allowedElements={allowedElements} components={markdownComponents} remarkPlugins={[remarkGfm]} skipHtml unwrapDisallowed urlTransform={(url) => safeUrl(url) ?? (onOpenLocalLink && url && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url) ? url : undefined)}>
          {source}
        </ReactMarkdown>
      </div>
    </StreamingContext.Provider></LocalLinkContext>
  )
})
