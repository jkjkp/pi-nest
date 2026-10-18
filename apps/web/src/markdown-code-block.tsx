import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Check, Copy, LoaderCircle, WrapText } from 'lucide-react'
import type { ThemedToken } from 'shiki/core'
import { Button } from '@/components/ui/button'

export const maxHighlightLength = 50_000

export function MarkdownCodeBlock({ code, language, isStreaming }: { code: string; language?: string; isStreaming: boolean }) {
  const [highlighted, setHighlighted] = useState<{ code: string; language: string; tokens: ThemedToken[][] }>()
  const [wrapped, setWrapped] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [copying, setCopying] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const copyAttempt = useRef(0)

  useEffect(() => () => { clearTimeout(copyTimer.current); copyAttempt.current++ }, [])
  useEffect(() => {
    // shortcut: highlight settled blocks up to 50,000 characters; revisit after profiling long replies.
    if (isStreaming || !language || code.length > maxHighlightLength) return
    let cancelled = false
    void import('./code-highlight.js').then(({ highlightCode }) => highlightCode(code, language)).then((tokens) => {
      if (!cancelled && tokens) setHighlighted({ code, language, tokens })
    }).catch(() => { /* Plain source remains usable when highlighting cannot load. */ })
    return () => { cancelled = true }
  }, [code, language, isStreaming])

  async function copy() {
    const attempt = ++copyAttempt.current
    clearTimeout(copyTimer.current)
    setCopying(true)
    setCopyStatus('')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(code)
      if (attempt !== copyAttempt.current) return
      setCopyStatus('已复制')
      copyTimer.current = setTimeout(() => setCopyStatus(''), 1500)
    } catch {
      if (attempt === copyAttempt.current) setCopyStatus('复制失败，请检查剪贴板权限后重试。')
    } finally {
      if (attempt === copyAttempt.current) setCopying(false)
    }
  }

  const tokens = !isStreaming && highlighted?.code === code && highlighted.language === language ? highlighted.tokens : undefined
  return <div className="my-3 min-w-0 overflow-hidden rounded-md border bg-muted/60" data-markdown-code-block="">
    <div className="flex min-w-0 items-center justify-between gap-3 border-b px-3 py-1.5 text-xs">
      <span className="min-w-0 truncate text-muted-foreground">{language || '文本'}</span>
      <div className="flex shrink-0 items-center gap-1">
        <Button aria-label="自动换行" aria-pressed={wrapped} title={wrapped ? '关闭自动换行' : '开启自动换行'} onClick={() => setWrapped(!wrapped)} size="icon-sm" type="button" variant={wrapped ? 'secondary' : 'ghost'}><WrapText aria-hidden="true" /></Button>
        <Button aria-label="复制代码" aria-busy={copying} title={copying ? '复制中…' : copyStatus === '已复制' ? '已复制' : '复制代码'} disabled={copying} onClick={() => void copy()} size="icon-sm" type="button" variant="ghost">{copying ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : copyStatus === '已复制' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</Button>
      </div>
    </div>
    <pre aria-label="代码" tabIndex={0} className={`markdown-code max-h-96 overflow-auto overscroll-contain p-3 text-xs leading-6 ${wrapped ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre [overflow-wrap:normal]'}`}><code>{tokens ? tokens.map((line, index) => <Fragment key={index}>{index > 0 ? '\n' : ''}{line.map((token, tokenIndex) => <span key={tokenIndex} style={{ color: token.color, ...token.htmlStyle } as CSSProperties}>{token.content}</span>)}</Fragment>) : code}</code></pre>
    <p aria-live="polite" className={copyStatus && copyStatus !== '已复制' ? 'border-t px-3 py-2 text-xs text-destructive' : 'sr-only'}>{copyStatus}</p>
  </div>
}
