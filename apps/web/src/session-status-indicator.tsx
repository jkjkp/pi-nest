import type { PromptStatus } from './session-run-model.js'

export function SessionStatusIndicator({ status, unread }: { status: PromptStatus; unread: boolean }) {
  const running = ['submitted', 'awaiting_agent', 'running', 'aborting'].includes(status)
  const label = running ? '正在回复' : status === 'awaiting_input' ? '等待你的回答' : status === 'error' ? '回复失败' : unread ? '有未读回复' : undefined
  if (!label) return null
  return <span aria-label={label} className="flex size-4 shrink-0 items-center justify-center" role="img">
    {running ? <svg aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" style={{ animationDuration: '1.8s' }} viewBox="0 0 16 16" fill="none" strokeWidth="2">
      <circle className="stroke-muted-foreground/20" cx="8" cy="8" r="6" />
      <circle className="stroke-foreground/80" cx="8" cy="8" r="6" strokeDasharray="28.274 9.425" transform="rotate(-90 8 8)" />
    </svg>
      : status === 'awaiting_input' ? <span className="size-1.5 rounded-full bg-amber-400" />
      : status === 'error' ? <span className="text-xs text-destructive">!</span>
      : unread ? <span className="size-[7px] rounded-full bg-blue-500" /> : null}
  </span>
}
