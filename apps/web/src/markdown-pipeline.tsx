// oxlint-disable react/only-export-components -- Parsing and conversion are shared with deterministic performance tests.
import { Fragment, memo, useMemo } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import type { Components } from 'react-markdown'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { toHast } from 'mdast-util-to-hast'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import type { Root, RootContent } from 'mdast'
import type { Element, Root as HastRoot, RootContent as HastContent } from 'hast'

export const allowedElements = ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'input', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']
const grammar = unified().use(remarkParse).use(remarkGfm).freeze()

export function parseMarkdown(source: string): Root {
  return grammar.parse(source)
}

export function safeUrl(value: string) {
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : undefined
  } catch {
    return undefined
  }
}

export function markdownUrl(value: string, allowLocal: boolean) {
  return safeUrl(value) ?? (allowLocal && value && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value) ? value : undefined)
}

function sanitize(parent: HastRoot | Element, allowLocal: boolean) {
  const children: HastContent[] = []
  for (const node of parent.children) {
    if (node.type === 'text') children.push(node)
    else if (node.type === 'element') {
      sanitize(node, allowLocal)
      if (!allowedElements.includes(node.tagName)) children.push(...node.children)
      else {
        if (node.tagName === 'a') node.properties.href = markdownUrl(String(node.properties.href ?? ''), allowLocal)
        children.push(node)
      }
    }
    // Raw HTML is never interpreted or rendered, matching ReactMarkdown's skipHtml.
  }
  parent.children = children
}

export function renderMarkdown(root: Root, components: Components, allowLocal: boolean) {
  const tree = toHast(root, { allowDangerousHtml: true })
  if (tree.type !== 'root') throw new Error('Expected a Markdown document')
  sanitize(tree, allowLocal)
  return toJsxRuntime(tree, { Fragment, jsx, jsxs, components, passKeys: true, passNode: true, ignoreInvalidStyle: true })
}

export const MarkdownBlock = memo(function MarkdownBlock({ node, components, allowLocal }: { node: RootContent | Root; components: Components; allowLocal: boolean }) {
  return useMemo(() => renderMarkdown(node.type === 'root' ? node : { type: 'root', children: [node] }, components, allowLocal), [node, components, allowLocal])
})
