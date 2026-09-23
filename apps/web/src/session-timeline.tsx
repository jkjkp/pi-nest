import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

import { AssistantMarkdown } from './assistant-markdown.js'
import type { PiSessionHistoryResponse } from './history.js'
import { diagnosticLabel, duration, rawJson, timelineItems, toolStatus, type RuntimeTurn, type TimelineItem, type TimelinePart } from './timeline-model.js'
import type { PiRuntimeEvent } from './runtime-websocket-client.js'
import { formatUpdatedAt } from './workspace.js'

export function SessionTimeline({ error, history, isLoading, isRunning = false, onRetry, systemEvents = [], turns = [] }: {
  error: boolean
  history: PiSessionHistoryResponse | undefined
  isLoading: boolean
  isRunning?: boolean
  onRetry: () => void
  systemEvents?: PiRuntimeEvent[]
  turns?: RuntimeTurn[]
}) {
  if (isLoading) return <LoadingTimeline />
  if (error) return <HistoryError onRetry={onRetry} />

  const items = timelineItems(history?.entries, turns, systemEvents)
  if (items.length === 0) {
    return <section className="py-8 text-center"><p className="text-sm text-muted-foreground">{isRunning ? '正在等待 Pi 原生事件…' : '当前活动分支尚无可展示的原生条目。'}</p></section>
  }

  return (
    <section className="space-y-5 pb-6">
      {history?.hasEarlier && <p className="rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">当前仅展示最近 200 条原生条目。</p>}
      {items.map((item) => <TurnItem isRunning={isRunning} item={item} key={item.id} />)}
    </section>
  )
}

function LoadingTimeline() {
  return <section aria-label="正在加载会话历史" className="space-y-7">{Array.from({ length: 3 }, (_, index) => <Skeleton className="h-20 max-w-2xl" key={index} />)}</section>
}

function HistoryError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="rounded-lg border border-destructive/30 border-l-2 border-l-destructive bg-destructive/5 p-4" role="alert">
      <h2 className="text-sm font-semibold">无法读取会话历史</h2>
      <p className="mt-2 text-sm text-muted-foreground">历史仍保留在本机原生会话中；请刷新后重试。</p>
      <Button className="mt-3" onClick={onRetry} size="sm" type="button" variant="secondary">重试</Button>
    </section>
  )
}

function TurnItem({ isRunning, item }: { isRunning: boolean; item: TimelineItem }) {
  return (
    <article className="space-y-3" data-turn-id={item.id}>
      {item.prompt && <div className="ml-auto max-w-[72%] rounded-[10px] bg-muted/75 px-4 py-3"><header className="text-xs font-medium text-foreground">用户 · <time className="font-normal text-muted-foreground" dateTime={item.startedAt}>{formatUpdatedAt(item.startedAt)}</time></header><pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[15px] leading-7">{item.prompt}</pre></div>}
      <div className="space-y-3">{item.parts.map((part, index) => <TimelinePartView isRunning={isRunning} key={`${part.kind}-${part.events[0]?.id ?? index}-${index}`} part={part} />)}</div>
      <TechnicalDetails item={item} />
    </article>
  )
}

function TimelinePartView({ isRunning, part }: { isRunning: boolean; part: TimelinePart }) {
  if (part.kind === 'assistant_text') return <article className="max-w-3xl"><AssistantMarkdown isStreaming={isRunning} source={part.text} /></article>
  if (part.kind === 'thinking') return <details className="rounded-md border bg-muted/30 px-3 py-2 text-sm" open={isRunning}><summary className="cursor-pointer font-medium text-muted-foreground">{isRunning ? '思考中' : '思考过程'}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-6">{part.text}</pre></details>
  if (part.kind === 'tool') return <ToolPart isRunning={isRunning} part={part} />
  if (part.kind === 'bash') return <BashPart isRunning={isRunning} part={part} />
  return <FileChangePart part={part} />
}

function ToolPart({ isRunning, part }: { isRunning: boolean; part: Extract<TimelinePart, { kind: 'tool' }> }) {
  const status = toolStatus(part.events)
  const elapsed = duration(part.events)
  return <details className="rounded-md border bg-card px-3 py-2 text-sm" open={isRunning && status === '正在执行'}><summary className="cursor-pointer font-medium">{status === '正在执行' ? '正在执行：' : ''}{part.toolName}<span className="ml-2 text-xs text-muted-foreground">{status}{elapsed === undefined ? '' : ` · ${formatDuration(elapsed)}`}</span></summary></details>
}

function BashPart({ isRunning, part }: { isRunning: boolean; part: Extract<TimelinePart, { kind: 'bash' }> }) {
  const latest = part.events.at(-1)?.event ?? {}
  const command = stringField(latest, 'command')
  const cwd = stringField(latest, 'cwd')
  const stdout = stringField(latest, 'stdout') ?? stringField(latest, 'output') ?? stringField(latest, 'delta')
  const stderr = stringField(latest, 'stderr')
  const exitCode = numberField(latest, 'exitCode')
  return (
    <details className="rounded-md border bg-card px-3 py-2 text-sm" open={isRunning}>
      <summary className="cursor-pointer font-medium">命令执行<span className="ml-2 text-xs text-muted-foreground">{exitCode === undefined ? '运行中' : `退出码 ${exitCode}`}</span></summary>
      <dl className="mt-3 space-y-2 text-xs">{command && <Field label="命令" value={command} />}{cwd && <Field label="工作目录" value={cwd} />}{stdout && <Field label="stdout" value={stdout} />}{stderr && <Field label="stderr" value={stderr} />}</dl>
    </details>
  )
}

function FileChangePart({ part }: { part: Extract<TimelinePart, { kind: 'file_change' }> }) {
  const changes = part.events.flatMap((event) => Array.isArray(event.event.changes) ? event.event.changes : [])
  return <details className="rounded-md border bg-card px-3 py-2 text-sm"><summary className="cursor-pointer font-medium">文件变更<span className="ml-2 text-xs text-muted-foreground">{changes.length ? `${changes.length} 项` : 'Pi 已报告变更'}</span></summary>{changes.length > 0 && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(changes, null, 2)}</pre>}</details>
}

function TechnicalDetails({ item }: { item: TimelineItem }) {
  return (
    <details className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">技术详情（{item.events.length} 条事件）</summary>
      {item.diagnostics.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4">{item.diagnostics.map((entry) => <li key={entry.event.id}>{diagnosticLabel(entry)}</li>)}</ul>}
      <p className="mt-3 font-medium">本轮原始事件</p>
      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-xs leading-5">{rawJson(item.events)}</pre>
    </details>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2">{value}</pre></dd></div>
}

function stringField(value: Record<string, unknown>, key: string) { return typeof value[key] === 'string' ? value[key] : undefined }
function numberField(value: Record<string, unknown>, key: string) { return typeof value[key] === 'number' ? value[key] : undefined }
function formatDuration(milliseconds: number) { return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} 秒` }
