import type { PromptStatus } from './session-run-model.js'

export function SessionStatusIndicator({ status, unread }: { status: PromptStatus; unread: boolean }) {
  const running = ['submitted', 'awaiting_agent', 'running', 'aborting'].includes(status)
  const label = running ? '正在回复' : status === 'awaiting_input' ? '等待你的回答' : status === 'error' ? '回复失败' : unread ? '有未读回复' : undefined
  return <span aria-label={label} className="flex size-4 shrink-0 items-center justify-center" role={label ? 'img' : undefined}>
    {running ? <span className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground motion-reduce:animate-none" />
      : status === 'awaiting_input' ? <span className="size-1.5 rounded-full bg-amber-400" />
      : status === 'error' ? <span className="text-xs text-destructive">!</span>
      : unread ? <span className="size-[7px] rounded-full bg-blue-500" /> : null}
  </span>
}
