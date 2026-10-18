import { useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { fetchSessionFilePreview } from './workspace-api.js'

export function SessionFilePreview({ sessionId, path, line, searchRoot, onClose }: { sessionId: string; path: string; line?: number; searchRoot?: string; onClose: () => void }) {
  const query = useQuery({ queryKey: ['session-file-preview', sessionId, searchRoot, path], queryFn: ({ signal }) => fetchSessionFilePreview(sessionId, path, signal, searchRoot), retry: false, refetchOnWindowFocus: false })
  const lines = query.data?.content.split('\n') ?? []
  const requestedLine = line && Number.isSafeInteger(line) && line > 0 ? line : 1
  const targetLine = Math.min(requestedLine, Math.max(1, lines.length))
  const [start, setStart] = useState(Math.max(0, requestedLine - 41))
  const visibleStart = Math.min(start, Math.max(0, lines.length - 1))
  const selected = useRef<HTMLSpanElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (query.data && selected.current && scroll.current) scroll.current.scrollTop = Math.max(0, selected.current.offsetTop - 48)
  }, [query.data, targetLine])
  return <section className="flex h-full min-h-0 flex-col" aria-label="当前文件预览">
    <header className="shrink-0 space-y-2 border-b p-3"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">当前文件</h2><Button type="button" size="sm" variant="ghost" onClick={onClose}>运行详情</Button></div><p className="break-all text-xs">{query.data?.path ?? path}</p><p className="text-xs text-muted-foreground">只读预览 · 当前内容可能与历史调用不同</p><Button type="button" size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>刷新文件</Button></header>
    {query.isPending ? <p role="status" className="p-4 text-sm text-muted-foreground">正在读取文件…</p> : query.isError ? <p role="alert" className="break-words p-4 text-sm text-destructive">{query.error.message}</p> : <>
      {requestedLine > lines.length && <p role="status" className="p-3 text-xs text-warning">原行号已超出当前文件，已定位至末尾。</p>}
      <div ref={scroll} className="relative min-h-0 flex-1 overflow-auto p-3" tabIndex={0} aria-label="文件文本"><pre className="w-max min-w-full font-mono text-xs leading-6">{lines.slice(visibleStart, visibleStart + 200).map((text, index) => {
        const number = visibleStart + index + 1
        return <span key={number} ref={number === targetLine ? selected : undefined} className={`block min-h-6 ${line && number === targetLine ? 'bg-accent' : ''}`}><span className="mr-4 inline-block w-10 select-none text-right text-muted-foreground" aria-hidden="true">{number}</span>{text}</span>
      })}</pre></div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-t p-2 text-xs text-muted-foreground"><Button type="button" size="sm" variant="ghost" disabled={visibleStart === 0} onClick={() => { setStart(Math.max(0, visibleStart - 200)); if (scroll.current) scroll.current.scrollTop = 0 }}>前 200 行</Button><span>{visibleStart + 1}–{Math.min(lines.length, visibleStart + 200)} / {lines.length}</span><Button type="button" size="sm" variant="ghost" disabled={visibleStart + 200 >= lines.length} onClick={() => { setStart(visibleStart + 200); if (scroll.current) scroll.current.scrollTop = 0 }}>后 200 行</Button></footer>
    </>}
  </section>
}
