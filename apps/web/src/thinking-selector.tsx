import { useEffect, useState } from 'react'
import { Brain, Check, ChevronDown, RefreshCw } from 'lucide-react'
import { Dialog, Popover, Portal } from 'radix-ui'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { thinkingLabel } from './thinking-command.js'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  current?: string
  levels: string[]
  status: 'unloaded' | 'loading' | 'ready' | 'error' | 'switching'
  error?: string
  failure: number
  disabled: boolean
  isActive: boolean
  onLoad: () => void
  onRetry: () => void
  onSelect: (level: string) => Promise<boolean>
}

export function ThinkingSelector({ open, onOpenChange, current, levels, status, error, failure, disabled, isActive, onLoad, onRetry, onSelect }: Props) {
  const [mobile, setMobile] = useState(false)
  const [dismissedFailure, setDismissedFailure] = useState(0)
  useEffect(() => {
    if (!failure) return
    const timer = window.setTimeout(() => setDismissedFailure(failure), 1_500)
    return () => window.clearTimeout(timer)
  }, [failure])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)')
    const update = () => setMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const busy = status === 'loading' || status === 'switching'
  const trigger = <Button aria-label={`选择思考等级：${current ? thinkingLabel(current) : '未设置'}`} data-composer-tooltip={`思考等级：${current ? thinkingLabel(current) : '未设置'}`} className="composer-thinking w-28 shrink-0" disabled={disabled} size="sm" variant="ghost" title={current}>
    <Brain aria-hidden="true" className="composer-control-icon hidden" />
    <span className="composer-control-label min-w-0 truncate"><span className="composer-thinking-prefix">{current ? '思考：' : '思考'}</span>{current ? thinkingLabel(current) : '等级'}</span>
    <ChevronDown aria-hidden="true" className="composer-control-chevron" />
  </Button>
  const contents = <>
    <div className="flex shrink-0 items-center justify-between border-b px-3 py-2"><span className="text-sm font-normal">思考等级</span><Button aria-label="刷新思考等级" disabled={busy || isActive} onClick={onRetry} size="icon-sm" variant="ghost"><RefreshCw aria-hidden="true" className={status === 'loading' ? 'animate-spin' : ''} /></Button></div>
    <div className="model-list-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5" role="group" aria-label="可用思考等级" onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      if (!buttons.length) return
      event.preventDefault()
      const index = buttons.indexOf(event.target as HTMLButtonElement)
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }}>{levels.map((level) => <button aria-pressed={level === current} disabled={busy || isActive || levels.length === 1} className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" key={level} onClick={() => void onSelect(level)} type="button"><span>{thinkingLabel(level)}<span className="ml-2 text-xs text-muted-foreground">{level}</span></span>{level === current && <Check aria-hidden="true" className="size-4" />}</button>)}
    {status === 'ready' && !levels.length && <p className="px-3 py-2 text-sm text-muted-foreground">暂无可用思考等级。</p>}
    {(status === 'loading' || (status === 'unloaded' && !isActive)) && !levels.length && <div aria-label="正在读取思考等级" aria-busy="true" className="space-y-2 p-3"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>}
    {error && <div className="px-3 py-2 text-xs text-destructive" role="alert">读取失败，请重试。<Button disabled={busy || isActive} onClick={onRetry} size="xs" variant="ghost">重试</Button></div>}
    {isActive && <p className="px-3 py-2 text-xs text-muted-foreground">生成结束后可调整思考等级。</p>}
    </div>
    {failure > dismissedFailure && <Portal.Root><div role="alert" className="pointer-events-none fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 whitespace-nowrap rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg">修改失败，请重试</div></Portal.Root>}
  </>
  function changeOpen(next: boolean) { onOpenChange(next); if (next) onLoad() }
  if (mobile) return <Dialog.Root open={open} onOpenChange={changeOpen}><Dialog.Trigger asChild>{trigger}</Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" /><Dialog.Content className="fixed inset-x-0 bottom-0 z-50 flex h-[min(280px,60dvh)] flex-col overflow-hidden rounded-t-xl border bg-popover pb-[env(safe-area-inset-bottom)] shadow-xl"><Dialog.Title className="sr-only">思考等级</Dialog.Title><Dialog.Description className="sr-only">调整当前会话使用的思考等级。</Dialog.Description>{contents}<Dialog.Close asChild><Button className="shrink-0" variant="ghost">关闭</Button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  return <Popover.Root open={open} onOpenChange={changeOpen}><Popover.Trigger asChild>{trigger}</Popover.Trigger><Popover.Portal><Popover.Content aria-label="思考等级" side="top" align="end" sideOffset={8} collisionPadding={12} className="z-50 flex h-[min(280px,var(--radix-popover-content-available-height))] w-64 max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl">{contents}</Popover.Content></Popover.Portal></Popover.Root>
}
