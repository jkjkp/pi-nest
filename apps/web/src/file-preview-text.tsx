import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { AssistantMarkdown } from './assistant-markdown.js'
import { useWorkspaceStore } from './workspace-store.js'
import { localMarkdownLink, type FileReadingPosition } from './file-preview-state.js'

type Reading = Pick<FileReadingPosition, 'start' | 'mode' | 'target'> & { locate?: boolean; resetScroll?: boolean }

export function FilePreviewText({ content, path, line, navigation, positionKey, onOpenFile }: {
  content: string; path: string; line?: number; navigation: number
  positionKey: string
  onOpenFile?: (path: string, line?: number) => void
}) {
  const markdown = /\.(md|markdown)$/i.test(path)
  const lines = content.split('\n')
  const requestedLine = line && Number.isSafeInteger(line) && line > 0 ? line : undefined
  const [saved] = useState(() => useWorkspaceStore.getState().fileReadingPositions[positionKey])
  const position = useRef<FileReadingPosition>(saved ?? { start: 0, scrollTop: 0, scrollLeft: 0, mode: markdown && !line ? 'reading' : 'source', zoom: 'fit' })
  const linePosition = (number: number): Reading => ({ start: Math.max(0, Math.min(number, lines.length) - 41), target: number, mode: 'source', locate: true, resetScroll: true })
  const [reading, setReading] = useState<Reading>(() => requestedLine && saved?.navigation !== navigation ? linePosition(requestedLine) : { start: saved?.start ?? 0, target: saved?.target, mode: markdown ? saved?.mode ?? (line ? 'source' : 'reading') : 'source' })
  const [appliedNavigation, setAppliedNavigation] = useState(navigation)
  if (appliedNavigation !== navigation) {
    setAppliedNavigation(navigation)
    if (requestedLine) setReading(linePosition(requestedLine))
  }
  const inputId = useId()
  const [jump, setJump] = useState('')
  const [jumpError, setJumpError] = useState('')
  const scroll = useRef<HTMLDivElement>(null)
  const selected = useRef<HTMLSpanElement>(null)
  const previousReading = useRef<Reading>(undefined)
  const start = Math.min(reading.start, Math.max(0, lines.length - 1))
  const target = reading.target ? Math.min(reading.target, lines.length) : undefined

  function navigateTo(number: number) {
    setReading(linePosition(number))
  }

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
  }

  return <>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
      {markdown && <div className="flex gap-1" role="group" aria-label="Markdown 显示模式">{(['source', 'reading'] as const).map((mode) => <Button type="button" size="sm" variant={reading.mode === mode ? 'secondary' : 'ghost'} aria-pressed={reading.mode === mode} key={mode} onClick={() => {
        setReading({ ...reading, mode, locate: false, resetScroll: true })
      }}>{mode === 'source' ? '源码' : '阅读'}</Button>)}</div>}
      <form className="flex items-center gap-1" onSubmit={(event) => {
        event.preventDefault()
        const value = Number(jump)
        if (!/^[1-9]\d*$/.test(jump) || !Number.isSafeInteger(value)) { setJumpError('请输入有效的正整数行号。'); return }
        setJumpError('')
        navigateTo(value)
      }}>
        <label htmlFor={inputId} className="sr-only">跳转到行</label>
        <input className="h-8 w-24 rounded-md border bg-background px-2" id={inputId} aria-invalid={Boolean(jumpError)} aria-describedby={jumpError ? `${inputId}-error` : undefined} inputMode="numeric" value={jump} placeholder="跳转到行" onChange={(event) => setJump(event.target.value)} />
        <Button type="submit" size="sm" variant="ghost">跳转</Button>
      </form>
      {requestedLine && <Button type="button" size="sm" variant="ghost" onClick={() => navigateTo(requestedLine)}>返回目标行</Button>}
    </div>
    {jumpError && <p id={`${inputId}-error`} role="alert" className="px-3 py-2 text-xs text-destructive">{jumpError}</p>}
    {reading.target && reading.target > lines.length && <p role="status" className="p-3 text-xs text-warning">原行号已超出当前文件，已定位至末尾。</p>}
    {content === '' ? <p role="status" className="p-4 text-sm text-muted-foreground">此文件为空。</p> : <div ref={scroll} className="relative min-h-0 flex-1 overflow-auto p-3" tabIndex={0} aria-label={reading.mode === 'reading' ? 'Markdown 阅读' : '文件文本'} onScroll={(event) => {
      position.current.scrollTop = event.currentTarget.scrollTop
      position.current.scrollLeft = event.currentTarget.scrollLeft
      useWorkspaceStore.getState().rememberFilePosition(positionKey, { ...position.current })
    }}>
      {reading.mode === 'reading' ? <AssistantMarkdown source={content} isStreaming={false} onOpenLocalLink={(href) => {
        const link = localMarkdownLink(path, href)
        if (link) onOpenFile?.(link.path, link.line)
      }} /> : <pre className="w-max min-w-full font-mono text-xs leading-6">{lines.slice(start, start + 200).map((text, index) => {
        const number = start + index + 1
        return <span key={number} ref={number === target ? selected : undefined} className={`block min-h-6 ${number === target ? 'bg-accent' : ''}`}><span className="mr-4 inline-block w-10 select-none text-right text-muted-foreground" aria-hidden="true">{number}</span>{text}</span>
      })}</pre>}
    </div>}
    {reading.mode === 'source' && content !== '' && <footer className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-t p-2 text-xs text-muted-foreground"><Button type="button" size="sm" variant="ghost" disabled={start === 0} onClick={() => page(Math.max(0, start - 200))}>前 200 行</Button><span>{start + 1}–{Math.min(lines.length, start + 200)} / {lines.length}</span><Button type="button" size="sm" variant="ghost" disabled={start + 200 >= lines.length} onClick={() => page(start + 200)}>后 200 行</Button></footer>}
  </>
}
