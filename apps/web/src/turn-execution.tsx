import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FilePenLine, Terminal, Wrench } from 'lucide-react'

import { formatActivityDuration, formatElapsedTime, nextExecutionExpanded, turnElapsed, type TurnActivity, type TurnPresentation } from './turn-execution-model.js'
import { startElapsedClock } from './turn-elapsed-clock.js'
import { shouldExecutionFollowLatest } from './turn-execution-scroll.js'
import type { TimelineItem } from './timeline-model.js'

export function TurnExecution({ item, isRunning, presentation }: { item: TimelineItem; isRunning: boolean; presentation: TurnPresentation }) {
  const [expanded, setExpanded] = useState(isRunning)
  const [userToggled, setUserToggled] = useState(false)
  const previousRunning = useRef(isRunning)
  const executionViewport = useRef<HTMLDivElement>(null)
  const [executionFollowLatest, setExecutionFollowLatest] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const contentId = `turn-execution-${item.id}`

  useEffect(() => {
    if (!isRunning) return
    return startElapsedClock(item.runtimeTiming?.startedAt ?? item.startedAt, setNow)
  }, [isRunning, item.id, item.runtimeTiming?.startedAt, item.startedAt])

  useEffect(() => {
    setExpanded((current) => nextExecutionExpanded(current, previousRunning.current, isRunning, userToggled))
    previousRunning.current = isRunning
  }, [isRunning, userToggled])

  useLayoutEffect(() => {
    if (!expanded || !executionFollowLatest || !executionViewport.current) return
    executionViewport.current.scrollTop = executionViewport.current.scrollHeight
  }, [expanded, executionFollowLatest, presentation.activities])

  const elapsed = formatElapsedTime(turnElapsed(item, isRunning, now))
  if (!presentation.hasExecution) return <section className="my-4 text-sm text-muted-foreground"><p>{isRunning ? `思考中 · ${elapsed}` : `用时 ${elapsed}`}</p><div className="mt-2 border-b border-border/60" /></section>

  return (
    <section className="my-4 text-sm" data-turn-execution="">
      <button aria-controls={contentId} aria-expanded={expanded} className="flex w-full items-center gap-1 text-left text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setUserToggled(true); if (!expanded) setExecutionFollowLatest(true); setExpanded((value) => !value) }} type="button">
        <span>{isRunning ? `思考中 · ${elapsed}` : `用时 ${elapsed}`}</span>
        {expanded ? <ChevronDown aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}
      </button>
      {expanded && <div className="py-3" id={contentId}>
        <div aria-label="执行过程" className="max-h-[min(38vh,22.5rem)] space-y-3 overflow-y-auto overscroll-contain pr-2" onScroll={() => {
          const viewport = executionViewport.current
          if (viewport) setExecutionFollowLatest(shouldExecutionFollowLatest(viewport.scrollHeight, viewport.scrollTop, viewport.clientHeight))
        }} ref={executionViewport}>{presentation.activities.map((activity) => <Activity activity={activity} key={activity.id} />)}</div>
        {!executionFollowLatest && <button className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {
          const viewport = executionViewport.current
          setExecutionFollowLatest(true)
          if (viewport) viewport.scrollTop = viewport.scrollHeight
        }} type="button">↓ 查看最新</button>}
      </div>}
      <div className="border-b border-border/60" />
    </section>
  )
}

function Activity({ activity }: { activity: TurnActivity }) {
  if (activity.kind === 'thinking' || activity.kind === 'narration') return <p className="whitespace-pre-wrap break-words leading-6 text-muted-foreground">{activity.text}</p>
  if (activity.kind === 'tool') return <ActivityLine icon={<Wrench aria-hidden="true" className="size-4" />} label={activity.label} status={`${activity.status}${activity.duration === undefined ? '' : ` · ${formatActivityDuration(activity.duration)}`}`} />
  if (activity.kind === 'bash') return <BashActivity activity={activity} />
  if (activity.kind === 'file_change') return <FileChangeActivity activity={activity} />
  return null
}

function ActivityLine({ icon, label, status }: { icon: ReactNode; label: string; status?: string }) {
  return <div className="flex items-start gap-2"><span className="mt-0.5 text-muted-foreground">{icon}</span><div className="min-w-0"><p className="break-words leading-5">{label}</p>{status && <p className="text-xs text-muted-foreground">{status}</p>}</div></div>
}

function BashActivity({ activity }: { activity: Extract<TurnActivity, { kind: 'bash' }> }) {
  const status = `${activity.status}${activity.exitCode && activity.exitCode !== 0 ? ` · exit ${activity.exitCode}` : ''}${activity.duration === undefined ? '' : ` · ${formatActivityDuration(activity.duration)}`}`
  if (!activity.command && !activity.cwd && !activity.stdout && !activity.stderr) return <ActivityLine icon={<Terminal aria-hidden="true" className="size-4" />} label="运行命令" status={status} />
  return <details className="group"><summary className="cursor-pointer list-none"><ActivityLine icon={<Terminal aria-hidden="true" className="size-4" />} label={activity.command ? `运行 ${activity.command}` : '运行命令'} status={status} /></summary><div className="mt-2 space-y-2 pl-6 text-xs"><Field label="命令" value={activity.command} /><Field label="工作目录" value={activity.cwd} /><Field label="stdout" value={activity.stdout} /><Field label="stderr" value={activity.stderr} /></div></details>
}

function FileChangeActivity({ activity }: { activity: Extract<TurnActivity, { kind: 'file_change' }> }) {
  if (activity.changes.length === 0) return <ActivityLine icon={<FilePenLine aria-hidden="true" className="size-4" />} label={activity.label} />
  return <details className="group"><summary className="cursor-pointer list-none"><ActivityLine icon={<FilePenLine aria-hidden="true" className="size-4" />} label={activity.label} /></summary><ul className="mt-2 space-y-1 pl-6 text-xs text-muted-foreground">{activity.changes.map((change, index) => <li className="flex gap-2" key={`${change.path}-${index}`}><span className="min-w-0 break-all">{change.path}</span>{(change.added !== undefined || change.removed !== undefined) && <span className="shrink-0">{change.added === undefined ? '' : `+${change.added}`} {change.removed === undefined ? '' : `-${change.removed}`}</span>}</li>)}</ul></details>
}

function Field({ label, value }: { label: string; value: string | undefined }) {
  return value ? <div><p className="text-muted-foreground">{label}</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono">{value}</pre></div> : null
}
