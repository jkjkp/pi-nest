import { type ReactNode } from 'react'
import { CircleAlert, Info, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogTrigger, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'

import { isRunActive, type SessionRunSummary } from './session-run-model.js'
import { type PiSessionSummary, formatUpdatedAt, runInspectorFields, sessionStatusLabel } from './workspace.js'

export function SessionInspector({ run, session }: { run: SessionRunSummary | undefined; session: PiSessionSummary | undefined }) {
  const status = run?.status ?? 'idle'
  const fields = runInspectorFields(run)

  return (
    <Dialog>
      <DialogTrigger asChild><Button aria-label="打开会话检查器" title="会话检查器" size="icon-sm" variant="ghost"><Info aria-hidden="true" /></Button></DialogTrigger>
      <DialogContent className="flex h-[min(40rem,calc(100dvh-2rem))] flex-col overflow-hidden p-0">
      <header className="relative shrink-0 border-b py-4 pr-14 pl-4">
        <DialogTitle>会话检查器</DialogTitle>
        <DialogDescription>运行摘要与安全元信息</DialogDescription>
        <DialogClose asChild><Button aria-label="关闭会话检查器" className="absolute top-3 right-3" size="icon-sm" variant="ghost"><X aria-hidden="true" /></Button></DialogClose>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 p-4 text-sm">
          <section aria-labelledby="inspector-runtime-heading" className="space-y-3">
            <h3 className="text-xs font-normal tracking-[0.12em] text-muted-foreground uppercase" id="inspector-runtime-heading">
              运行
            </h3>
            <dl className="space-y-4">
              <InspectorItem label="运行状态"><StatusBadge status={status} /></InspectorItem>
              <InspectorItem label="本工作台原生事件"><InspectorCodeValue value={fields.eventCount} /></InspectorItem>
              <InspectorItem label="终止原因"><InspectorCodeValue value={fields.stopReason} /></InspectorItem>
              <InspectorItem label="最近错误">
                {fields.error ? (
                  <span className="flex break-words gap-2 text-destructive">
                    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    {fields.error}
                  </span>
                ) : <InspectorUnavailable />}
              </InspectorItem>
            </dl>
          </section>

          <section aria-labelledby="inspector-session-heading" className="space-y-3 border-t pt-5">
            <h3 className="text-xs font-normal tracking-[0.12em] text-muted-foreground uppercase" id="inspector-session-heading">
              会话
            </h3>
            <dl className="space-y-4">
              <InspectorItem label="Session ID"><InspectorCodeValue value={session?.id ?? '未选择'} /></InspectorItem>
              <InspectorItem label="项目目录"><InspectorCodeValue value={session?.cwd ?? '当前不可用'} /></InspectorItem>
              <InspectorItem label="最近更新">{formatUpdatedAt(session?.updatedAt)}</InspectorItem>
              <InspectorItem label="模型"><InspectorCodeValue value={fields.model} /></InspectorItem>
              <InspectorItem label="Thinking"><InspectorUnavailable /></InspectorItem>
              <InspectorItem label="工具">以 Pi CLI 实际执行为准</InspectorItem>
            </dl>
          </section>
        </div>
      </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function InspectorCodeValue({ value }: { value: string }) {
  return <span className={`break-all font-mono text-xs tabular-nums ${value === '当前不可用' ? 'text-muted-foreground' : ''}`}>{value}</span>
}

function InspectorUnavailable() {
  return <span className="text-muted-foreground">当前不可用</span>
}

function InspectorItem({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-normal text-muted-foreground">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  )
}

function StatusBadge({ status }: { status: Parameters<typeof sessionStatusLabel>[0] }) {
  const current = status ?? 'idle'
  const color = isRunActive(current) ? 'text-warning' : current === 'complete' ? 'text-success' : current === 'error' ? 'text-destructive' : 'text-muted-foreground'
  return <span className={`text-xs font-normal ${color}`}>{sessionStatusLabel(status)}</span>
}
