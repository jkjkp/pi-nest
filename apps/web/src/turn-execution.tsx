import { ToolResultCard, ToolFilePath } from './tool-result-card.js'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, FilePenLine, Wrench } from 'lucide-react'

import { executionPhase, formatActivityDuration, formatElapsedTime, nextExecutionExpanded, turnElapsed, type TurnActivity, type TurnPresentation } from './turn-execution-model.js'
import { startElapsedClock } from './turn-elapsed-clock.js'
import { shouldExecutionFollowLatest } from './turn-execution-scroll.js'
import type { TimelineItem } from './timeline-model.js'
import type { PromptStatus } from './session-run-model.js'

export function TurnExecution({ item, isRunning, presentation, runMessage, runStatus }: { item: TimelineItem; isRunning: boolean; presentation: TurnPresentation; runMessage?: string; runStatus?: PromptStatus }) {
  const [expanded, setExpanded] = useState(isRunning)
  const [contentMounted, setContentMounted] = useState(isRunning)
  const [userToggled, setUserToggled] = useState(false)
  const executionActive = isRunning || runStatus === 'awaiting_input'
  const previousRunning = useRef(executionActive)
  const executionViewport = useRef<HTMLDivElement>(null)
  const [executionFollowLatest, setExecutionFollowLatest] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const contentId = `turn-execution-${item.id}`
  const changedFiles = new Set(presentation.activities.flatMap((activity) => activity.kind === 'tool' && activity.result?.status === '完成' && ['edit', 'write'].includes(activity.result.view) && activity.result.path ? [activity.result.path] : activity.kind === 'file_change' ? activity.changes.map((change) => change.path) : []))
  const failures = presentation.activities.filter((activity) => (activity.kind === 'tool' || activity.kind === 'bash') && activity.status === '失败')
  const resultTarget = failures[0] ?? presentation.activities.find((activity) => activity.kind === 'tool' && activity.result?.status === '完成' && ['edit', 'write'].includes(activity.result.view) || activity.kind === 'file_change')

  function revealResult() {
    setUserToggled(true)
    setExpanded(true)
    setExecutionFollowLatest(false)
    requestAnimationFrame(() => {
      const target = [...(executionViewport.current?.querySelectorAll<HTMLElement>('[data-activity-id]') ?? [])].find((element) => element.dataset.activityId === resultTarget?.id)
      const details = target?.querySelector('details')
      if (details) details.open = true
      target?.scrollIntoView({ block: 'nearest' })
      const summary = details?.querySelector('summary')
      summary?.focus({ preventScroll: true })
    })
  }

  useEffect(() => {
    if (!executionActive) return
    return startElapsedClock(item.runtimeTiming?.startedAt ?? item.startedAt, setNow)
  }, [executionActive, item.id, item.runtimeTiming?.startedAt, item.startedAt])

  useEffect(() => {
    setExpanded((current) => nextExecutionExpanded(current, previousRunning.current, executionActive, userToggled))
    previousRunning.current = executionActive
  }, [executionActive, userToggled])

  useLayoutEffect(() => {
    if (!expanded || !executionFollowLatest || !executionViewport.current) return
    executionViewport.current.scrollTop = executionViewport.current.scrollHeight
  }, [expanded, executionFollowLatest, presentation.activities])

  const elapsed = formatElapsedTime(turnElapsed(item, executionActive, now))
  const phase = executionPhase(item, presentation, runStatus, runMessage)
  const statusText = executionActive ? `${phase} · ${elapsed}`
    : runStatus === 'submitted' || runStatus === 'awaiting_agent' || runStatus === 'aborting' || runStatus === 'aborted' || runStatus === 'error'
      ? phase : elapsed === '—' ? '正在同步执行状态…' : `用时 ${elapsed}`
  if (expanded && !contentMounted) setContentMounted(true)
  const contentExpanded = expanded && presentation.hasExecution

  return (
    <section className="my-4 text-sm" data-turn-execution="">
      {(changedFiles.size > 0 || failures.length > 0) && <button type="button" className="mb-2 block text-left text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-controls={contentId} onClick={revealResult}>{[changedFiles.size > 0 ? `修改 ${changedFiles.size} 个文件` : '', failures.length > 0 ? `${failures.length} 项执行失败` : ''].filter(Boolean).join(' · ')} · 查看结果</button>}
      {presentation.hasExecution ? <button data-execution-toggle="" aria-controls={contentId} aria-expanded={expanded} className="flex w-full items-center gap-1 text-left text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setUserToggled(true); if (!expanded) setExecutionFollowLatest(true); setExpanded((value) => !value) }} type="button">
        <span><span aria-live="polite">{isRunning ? phase : statusText}</span>{isRunning ? ` · ${elapsed}` : null}</span>
        <ChevronRight aria-hidden="true" className={`size-4 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
      </button> : <p className="text-muted-foreground"><span aria-live="polite">{isRunning ? phase : statusText}</span>{isRunning ? ` · ${elapsed}` : null}</p>}
      <div className="execution-collapse" data-expanded={contentExpanded} aria-hidden={!contentExpanded} inert={!contentExpanded} id={contentId}>
        <div className="min-h-0 overflow-hidden"><div className="py-3">
        {contentMounted && <>
        <div aria-label="执行过程" className="max-h-[min(38vh,22.5rem)] space-y-3 overflow-y-auto overscroll-contain pr-2" onScroll={() => {
          const viewport = executionViewport.current
          if (viewport) setExecutionFollowLatest(shouldExecutionFollowLatest(viewport.scrollHeight, viewport.scrollTop, viewport.clientHeight))
        }} onClickCapture={(event) => { if ((event.target as HTMLElement).closest('summary, button')) setExecutionFollowLatest(false) }} ref={executionViewport}>{presentation.activities.map((activity) => <div data-activity-id={activity.id} key={activity.id}><Activity activity={activity} /></div>)}</div>
        {!executionFollowLatest && <button className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {
          const viewport = executionViewport.current
          setExecutionFollowLatest(true)
          if (viewport) viewport.scrollTop = viewport.scrollHeight
        }} type="button">↓ 查看最新</button>}
        </>}
        </div></div>
      </div>
      <div className="border-b border-border/60" />
    </section>
  )
}

function Activity({ activity }: { activity: TurnActivity }) {
  if (activity.kind === 'thinking' || activity.kind === 'narration') return <p className="whitespace-pre-wrap break-words leading-6 text-muted-foreground">{activity.text}</p>
  if (activity.kind === 'tool' && activity.result) return <ToolResultCard result={activity.result} label={activity.label} duration={activity.duration === undefined ? undefined : formatActivityDuration(activity.duration)} />
  if (activity.kind === 'tool') return <ActivityLine icon={<Wrench aria-hidden="true" className="size-4" />} label={activity.label} status={`${activity.status}${activity.duration === undefined ? '' : ` · ${formatActivityDuration(activity.duration)}`}`} />
  if (activity.kind === 'bash') return <BashActivity activity={activity} />
  if (activity.kind === 'file_change') return <FileChangeActivity activity={activity} />
  if (activity.kind === 'retry') return <p className="text-muted-foreground">{activity.label}</p>
  return null
}

function ActivityLine({ icon, label, status }: { icon: ReactNode; label: string; status?: string }) {
  return <div className="flex items-start gap-2"><span className="mt-0.5 text-muted-foreground">{icon}</span><div className="min-w-0"><p className="break-words leading-5">{label}</p>{status && <p className="text-xs text-muted-foreground">{status}</p>}</div></div>
}

function BashActivity({ activity }: { activity: Extract<TurnActivity, { kind: 'bash' }> }) {
  return <ToolResultCard label={activity.command ? `运行 ${activity.command}` : '运行命令'} duration={activity.duration === undefined ? undefined : formatActivityDuration(activity.duration)} result={{
    name: 'bash', view: 'bash', args: { command: activity.command, cwd: activity.cwd }, status: activity.status,
    output: [activity.stdout, activity.stderr ? `stderr:\n${activity.stderr}` : undefined].filter(Boolean).join('\n'), details: { exitCode: activity.exitCode }, notices: [],
  }} />
}

function FileChangeActivity({ activity }: { activity: Extract<TurnActivity, { kind: 'file_change' }> }) {
  if (activity.changes.length === 0) return <ActivityLine icon={<FilePenLine aria-hidden="true" className="size-4" />} label={activity.label} />
  return <details className="group"><summary className="cursor-pointer list-none"><ActivityLine icon={<FilePenLine aria-hidden="true" className="size-4" />} label={activity.label} /></summary><ul className="mt-2 space-y-1 pl-6 text-xs text-muted-foreground">{activity.changes.map((change, index) => <li className="flex gap-2" key={`${change.path}-${index}`}><ToolFilePath path={change.path} />{(change.added !== undefined || change.removed !== undefined) && <span className="shrink-0">{change.added === undefined ? '' : `+${change.added}`} {change.removed === undefined ? '' : `-${change.removed}`}</span>}</li>)}</ul></details>
}
