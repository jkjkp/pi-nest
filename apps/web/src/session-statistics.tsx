import { useEffect, useRef, useState } from 'react'
import { Popover } from 'radix-ui'
import type { RuntimeStatisticsState } from './workspace-store.js'
import { Button } from '@/components/ui/button'

function formatStatisticsTokens(value: number) {
  if (value < 1000) return String(Math.round(value))
  if (value < 1000000) return `${value < 10000 ? (value / 1000).toFixed(1) : Math.round(value / 1000)}k`
  return `${value < 10000000 ? (value / 1000000).toFixed(1) : Math.round(value / 1000000)}M`
}

export function SessionStatistics({ details, onRetry, open: controlledOpen, onOpenChange }: { details?: RuntimeStatisticsState; onRetry: () => void; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  function setOpen(next: boolean) { setLocalOpen(next); onOpenChange?.(next) }
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointerType = useRef('mouse')
  useEffect(() => () => clearTimeout(timer.current), [])
  const stats = details?.data
  const context = stats?.contextUsage
  const percent = context?.percent
  const known = percent !== undefined && percent !== null
  const awaitingUsage = context?.tokens === null && percent === null
  function changeOpen(next: boolean) {
    clearTimeout(timer.current)
    setOpen(next)
    if (next && !stats && !details?.loading && !details?.error) onRetry()
  }
  function enter(event: React.PointerEvent) {
    if (event.pointerType !== 'mouse') return
    clearTimeout(timer.current)
    if (!open) timer.current = setTimeout(() => changeOpen(true), 150)
  }
  function leave(event: React.PointerEvent | React.FocusEvent) {
    const next = event.relatedTarget as Node | null
    if (trigger.current?.contains(next) || content.current?.contains(next)) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => changeOpen(false), 150)
  }
  const progress = known ? Math.max(0, Math.min(100, percent)) : 0
  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger asChild><Button ref={trigger} aria-label={`会话用量与上下文：${known ? `${percent.toFixed(1)}%` : awaitingUsage ? '上下文用量待更新' : '占用未知'}`} className="relative size-8 shrink-0 rounded-full p-0 text-muted-foreground" size="icon-sm" type="button" variant="ghost" onPointerEnter={enter} onPointerLeave={leave} onPointerDown={(event) => { pointerType.current = event.pointerType }} onClick={(event) => { if (pointerType.current === 'mouse' && event.detail > 0) event.preventDefault() }} onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) changeOpen(true) }} onBlur={leave}>
      <svg className="size-7" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-20" />
        {known && <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="2" pathLength="100" strokeDasharray={`${progress} 100`} transform="rotate(-90 16 16)" />}
      </svg>
      <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-[8px] tabular-nums">{known ? `${Math.round(percent)}%` : '—'}</span>
    </Button></Popover.Trigger>
    <Popover.Portal><Popover.Content ref={content} onPointerEnter={enter} onPointerLeave={leave} onFocusCapture={() => clearTimeout(timer.current)} onBlurCapture={leave} onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()} side="top" align="end" sideOffset={8} collisionPadding={12} className="z-50 w-72 max-w-[calc(100vw-24px)] rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
      <h2 className="font-normal">会话用量与上下文</h2>
      {details?.loading && stats && <p role="status" className="mt-2 text-xs text-muted-foreground">正在读取统计…</p>}
      {awaitingUsage && <p role="status" className="mt-2 text-xs text-muted-foreground">上下文用量待更新。压缩后的用量将在下一次有效模型回复后更新。</p>}
      {stats && !context && <p className="mt-2 text-xs text-muted-foreground">上下文统计暂不可用。</p>}
      {known && <p className="mt-2 text-xs text-muted-foreground">上下文占用 {percent.toFixed(1)}%</p>}
      {stats ? <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs">
        <dt>当前上下文</dt><dd>{context ? `${context.tokens === null ? '待更新' : formatStatisticsTokens(context.tokens)} / ${formatStatisticsTokens(context.contextWindow)}` : '未知'}</dd>
        <dt>自动压缩</dt><dd>{stats.autoCompactionEnabled === undefined ? '未知' : stats.autoCompactionEnabled ? '已开启' : '已关闭'}</dd>
        <dt>累计输入 ↑</dt><dd>{formatStatisticsTokens(stats.tokens.input)}</dd>
        <dt>累计输出 ↓</dt><dd>{formatStatisticsTokens(stats.tokens.output)}</dd>
        <dt>缓存读取 R</dt><dd>{formatStatisticsTokens(stats.tokens.cacheRead)}</dd>
        <dt>缓存写入 W</dt><dd>{formatStatisticsTokens(stats.tokens.cacheWrite)}</dd>
        <dt>最近请求缓存命中率</dt><dd>{stats.cacheHitRate === undefined ? '未知' : `${stats.cacheHitRate.toFixed(1)}%`}</dd>
        <dt>Pi 估算成本</dt><dd>${stats.cost.toFixed(3)}</dd>
      </dl> : <p className="mt-3 text-xs text-muted-foreground">{details?.loading ? '正在读取统计…' : '统计暂不可用。'}</p>}
      {stats && <p className="mt-3 text-xs text-muted-foreground">累计用量包含会话分支及压缩消耗；估算成本不代表实际扣款或订阅余额。</p>}
      {details?.error && <p role="status" className="mt-2 text-xs text-destructive">{details.error}{stats ? ' 当前显示上次读取的数据。' : ''}</p>}
      {details?.error && <button className="mt-2 text-xs underline underline-offset-2 disabled:opacity-50" disabled={details.loading} onClick={onRetry} type="button">{details.loading ? '重试中…' : '重试'}</button>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
