import type { TextFilePage } from '@pi-nest/contracts'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { AssistantMarkdown } from './assistant-markdown.js'
import { useWorkspaceStore } from './workspace-store.js'
import { localMarkdownLink, type FileReadingPosition } from './file-preview-state.js'

type Reading = Pick<FileReadingPosition, 'start' | 'mode' | 'target'> & { locate?: boolean; resetScroll?: boolean }

export function FilePreviewText({ content, path, line, navigation, positionKey, onOpenFile, pageInfo }: {
  content: string; path: string; line?: number; navigation: number
  positionKey: string
  pageInfo?: TextFilePage & { onNext: () => void; onPrevious: () => void; prefetchNext: () => void; loading: boolean; changed: boolean }
  onOpenFile?: (path: string, line?: number) => void
}) {
  const markdown = !pageInfo && /\.(md|markdown)$/i.test(path)
  const lines = (pageInfo && content.endsWith('\n') ? content.slice(0, -1) : content).split('\n')
  const firstLine = pageInfo?.cursor.line ?? 1
  const requestedLine = line && Number.isSafeInteger(line) && line >= firstLine && (!pageInfo || line <= pageInfo.lastLine || pageInfo.eof) ? line - firstLine + 1 : undefined
  const [saved] = useState(() => useWorkspaceStore.getState().fileReadingPositions[positionKey])
  const position = useRef<FileReadingPosition>(saved ?? { start: 0, scrollTop: 0, scrollLeft: 0, mode: markdown && !line ? 'reading' : 'source', zoom: 'fit' })
  const linePosition = (number: number): Reading => ({ start: Math.max(0, Math.min(number, lines.length) - 41), target: number, mode: 'source', locate: true, resetScroll: true })
  const [reading, setReading] = useState<Reading>(() => requestedLine && saved?.navigation !== navigation ? linePosition(requestedLine) : { start: saved?.start ?? 0, target: saved?.target, mode: markdown && !requestedLine ? 'reading' : 'source' })
  const [appliedNavigation, setAppliedNavigation] = useState(navigation)
  if (appliedNavigation !== navigation) {
    setAppliedNavigation(navigation)
    setReading(requestedLine ? linePosition(requestedLine) : { ...reading, mode: markdown ? 'reading' : 'source' })
  }
  const scroll = useRef<HTMLDivElement>(null)
  const selected = useRef<HTMLSpanElement>(null)
  const previousReading = useRef<Reading>(undefined)
  const start = Math.min(reading.start, Math.max(0, lines.length - 1))
  const target = reading.target ? Math.min(reading.target, lines.length) : undefined

  const absoluteTarget = target === undefined ? undefined : firstLine + target - 1

  useLayoutEffect(() => {
    const changed = previousReading.current !== reading
    previousReading.current = reading
    position.current = { ...position.current, start, mode: reading.mode, target: reading.target, navigation }
    if (!scroll.current) { useWorkspaceStore.getState().rememberFilePosition(positionKey, { ...position.current }); return }
    scroll.current.scrollTop = changed && reading.locate && selected.current ? Math.max(0, selected.current.offsetTop - 48)
      : changed && reading.resetScroll ? 0 : position.current.scrollTop
    scroll.current.scrollLeft = changed && reading.resetScroll ? 0 : position.current.scrollLeft
    position.current.scrollTop = scroll.current.scrollTop
    position.current.scrollLeft = scroll.current.scrollLeft
    useWorkspaceStore.getState().rememberFilePosition(positionKey, { ...position.current })
  }, [content, navigation, reading, start, positionKey])

  function page(next: number) {
    setReading({ ...reading, start: next, locate: false, resetScroll: true })
    if (next + 200 >= lines.length) pageInfo?.prefetchNext()
  }

  return <>
    {reading.target && reading.target > lines.length && (!pageInfo || pageInfo.eof) && <p role="status" className="p-3 text-xs text-warning">原行号已超出当前文件，已定位至末尾。</p>}
    {(pageInfo?.startsMidLine || pageInfo?.endsMidLine) && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">当前包含超长行片段，可继续翻页查看。</p>}
    {content === '' ? <p role="status" className="p-4 text-sm text-muted-foreground">此文件为空。</p> : <div ref={scroll} className="relative min-h-0 flex-1 overflow-auto p-3" tabIndex={0} aria-label={reading.mode === 'reading' ? 'Markdown 阅读' : '文件文本'} onScroll={(event) => {
      position.current.scrollTop = event.currentTarget.scrollTop
      position.current.scrollLeft = event.currentTarget.scrollLeft
      useWorkspaceStore.getState().rememberFilePosition(positionKey, { ...position.current })
      if (start + 200 >= lines.length && event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 160) pageInfo?.prefetchNext()
    }}>
      {reading.mode === 'reading' ? <AssistantMarkdown source={content} isStreaming={false} onOpenLocalLink={(href) => {
        const link = localMarkdownLink(path, href)
        if (link) onOpenFile?.(link.path, link.line)
      }} /> : <pre className="w-max min-w-full font-mono text-xs leading-6">{lines.slice(start, start + 200).map((text, index) => {
        const number = firstLine + start + index
        return <span key={number} ref={number === absoluteTarget ? selected : undefined} className={`block min-h-6 ${number === absoluteTarget ? 'bg-accent' : ''}`}><span className="mr-4 inline-block w-10 select-none text-right text-muted-foreground" aria-hidden="true">{number}</span>{text}</span>
      })}</pre>}
    </div>}
    {reading.mode === 'source' && content !== '' && <footer className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-t p-2 text-xs text-muted-foreground"><Button type="button" size="sm" variant="ghost" disabled={pageInfo?.loading || pageInfo?.changed || start === 0 && (!pageInfo || pageInfo.cursor.offset === 0)} onClick={() => start === 0 && pageInfo ? pageInfo.onPrevious() : page(Math.max(0, start - 200))}>{pageInfo?.startsMidLine && lines.length === 1 ? '上一片段' : '前 200 行'}</Button><span>{firstLine + start}–{firstLine - 1 + Math.min(lines.length, start + 200)} / {pageInfo && !pageInfo.eof ? '尚未读完' : pageInfo?.lastLine ?? lines.length}</span><Button type="button" size="sm" variant="ghost" disabled={pageInfo?.loading || pageInfo?.changed || start + 200 >= lines.length && !pageInfo?.nextCursor} onClick={() => start + 200 >= lines.length && pageInfo ? pageInfo.onNext() : page(start + 200)}>{pageInfo?.endsMidLine && lines.length === 1 ? '下一片段' : '后 200 行'}</Button></footer>}
  </>
}
