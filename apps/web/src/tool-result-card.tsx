import { useContext, useState } from 'react'
import { FileText, Terminal, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { searchMatches, type ToolResult } from './tool-result-model.js'

import { OpenToolFile } from './tool-file-context.js'

export function ToolFilePath({ path, line, searchRoot, label = path }: { path: string; line?: number; searchRoot?: string; label?: string }) {
  const open = useContext(OpenToolFile)
  return open ? <button type="button" className="break-all text-left text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); open(path, line, searchRoot) }} title="查看当前文件（可能与历史内容不同）">{label}{line ? `:${line}` : ''}</button> : <span className="break-all">{label}{line ? `:${line}` : ''}</span>
}

function TextResult({ text, diff = false }: { text: string; diff?: boolean }) {
  const [limit, setLimit] = useState(200)
  const clipped = text.slice(0, 100_000)
  const lines = clipped.split('\n')
  return <div><pre tabIndex={0} aria-label={diff ? '本次调用修改差异' : '工具结果文本'} className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[13px] leading-[22px]">{lines.slice(0, limit).map((line, index) => <span key={index} className={`block min-h-[22px] ${diff && line.startsWith('+') && !line.startsWith('+++') ? 'bg-success/10 text-success' : diff && line.startsWith('-') && !line.startsWith('---') ? 'bg-destructive/10 text-destructive' : ''}`}>{line}</span>)}</pre>{lines.length > limit && <Button size="sm" type="button" variant="ghost" onClick={() => setLimit(limit + 200)}>显示更多行（剩余 {lines.length - limit} 行）</Button>}{text.length > clipped.length && <p className="text-xs text-muted-foreground">页面预览仅展示前 100,000 个字符。</p>}</div>
}

export function ToolResultCard({ result, label, duration }: { result: ToolResult; label: string; duration?: string }) {
  const [open, setOpen] = useState(false)
  const { args, status, view } = result
  const [matchLimit, setMatchLimit] = useState(200)
  const matches = searchMatches(result)
  const grouped = new Map<string, NonNullable<typeof matches>>()
  for (const match of matches?.slice(0, matchLimit) ?? []) grouped.set(match.path, [...(grouped.get(match.path) ?? []), match])
  const diff = result.patch || result.diff
  const command = typeof args.command === 'string' ? args.command : undefined
  const written = typeof args.content === 'string' ? args.content : undefined
  const exitCode = typeof result.details.exitCode === 'number' ? result.details.exitCode : undefined
  const action = view === 'bash' ? '运行' : view === 'write' ? '写入' : /^(读取|搜索|编辑|运行)/.exec(label)?.[0]
  const subject = view === 'bash' ? command ?? label.replace(/^运行\s*/, '') : view === 'write' ? result.path ?? label.replace(/^编辑\s*/, '') : action ? label.slice(action.length).trimStart() : label
  const verb = action ?? '调用'
  const prefix = status === '正在执行' ? `正在${verb}` : status === '完成' ? `已${verb}` : status === '失败' ? `${verb}失败` : status
  const title = `${prefix} ${subject}`.replace(/\s*\r?\n\s*/g, ' ')
  const metadata = <span className={`text-xs ${status === '失败' ? 'text-destructive' : 'text-muted-foreground'}`}>{status}{exitCode !== undefined ? ` · exit ${exitCode}` : ''}{duration ? ` · ${duration}` : ''}{result.changes ? ` · +${result.changes.added} −${result.changes.removed}` : ''}</span>
  const Icon = view === 'bash' ? Terminal : result.path ? FileText : Wrench
  return <details className="group min-w-0" data-tool-result="" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className={`flex cursor-pointer list-none items-center gap-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden ${status === '失败' ? 'text-destructive' : 'text-muted-foreground'}`}><Icon aria-hidden="true" className="size-4 shrink-0" /><span className={`min-w-0 flex-1 truncate${status === '正在执行' ? ' command-running' : ''}`} title={title}>{title}</span></summary>
    {open && <div className="space-y-3 pt-2 pl-6">
      <p>{metadata}</p>
      {result.path && view !== 'grep' && <div className="text-xs"><ToolFilePath path={result.path} line={typeof result.details.firstChangedLine === 'number' ? result.details.firstChangedLine : view === 'read' && typeof args.offset === 'number' ? args.offset : undefined} /></div>}
      {view === 'read' && <p className="text-xs text-muted-foreground">当时读取的内容 · 第 {typeof args.offset === 'number' ? args.offset : 1} 行起{typeof args.limit === 'number' ? `，请求最多 ${args.limit} 行` : ''}</p>}
      {view === 'grep' && <p className="break-words text-xs text-muted-foreground">搜索范围：{result.path ?? '.'} · 搜索 {typeof args.pattern === 'string' ? args.pattern : ''}{typeof args.glob === 'string' ? ` · ${args.glob}` : ''}</p>}
      {view === 'bash' && command !== undefined && <section aria-label="命令"><TextResult text={command} /></section>}
      {typeof args.cwd === 'string' && <p className="break-all text-xs text-muted-foreground">工作目录：{args.cwd}</p>}
      {view === 'edit' && status === '完成' && diff && <section><TextResult text={diff} diff /></section>}
      {view === 'write' && written !== undefined && <section aria-label="提交的写入内容"><p className="mb-2 text-xs text-muted-foreground">{status === '完成' ? '本次已写入的内容' : '提交的写入内容（不代表已写入）'}</p><TextResult text={written} /></section>}
      {matches ? <section aria-label="搜索匹配" className="max-h-96 space-y-3 overflow-auto">{[...grouped].map(([path, rows]) => <div key={path}><ToolFilePath path={path} searchRoot={result.path} /><div className="overflow-auto whitespace-pre font-mono text-[13px] leading-[22px]">{rows.map((row, index) => <div key={index}><ToolFilePath path={path} searchRoot={result.path} line={row.line} />{' '}{row.text}</div>)}</div></div>)}{matches.length > matchLimit && <Button type="button" size="sm" variant="ghost" onClick={() => setMatchLimit(matchLimit + 200)}>显示更多匹配（剩余 {matches.length - matchLimit} 条）</Button>}</section> : result.output && <section aria-label={status === '失败' ? '工具错误与输出' : '工具输出'}><TextResult text={result.output} /></section>}
      {status === '完成' && !result.output && !diff && <p className="text-xs text-muted-foreground">工具未返回可展示的文本。</p>}
      {result.notices.map((notice) => <p className="break-all text-xs text-warning" key={notice}>{notice}</p>)}
      <details><summary className="cursor-pointer text-xs text-muted-foreground">调用参数</summary><TextResult text={JSON.stringify(args, null, 2)} /></details>
    </div>}
  </details>
}
