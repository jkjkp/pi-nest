import { type ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'

import type { SessionRunSummary } from './workspace-store.js'
import { type PiSessionSummary, formatUpdatedAt, runInspectorFields, sessionStatusLabel } from './workspace.js'

export function SessionInspector({ run, session }: { run: SessionRunSummary | undefined; session: PiSessionSummary | undefined }) {
  const status = run?.status ?? 'idle'
  const fields = runInspectorFields(run)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-4">
        <h2 className="text-sm font-semibold">会话检查器</h2>
        <p className="mt-1 text-xs text-muted-foreground">运行摘要与安全元信息</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 p-4 text-sm">
          <section aria-labelledby="inspector-runtime-heading" className="space-y-3">
            <h3 className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase" id="inspector-runtime-heading">
              运行
            </h3>
            <dl className="space-y-4">
              <InspectorItem label="运行状态"><StatusBadge status={status} /></InspectorItem>
              <InspectorItem label="本工作台文本增量事件"><InspectorCodeValue value={fields.textDeltaCount} /></InspectorItem>
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
            <h3 className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase" id="inspector-session-heading">
              会话
            </h3>
            <dl className="space-y-4">
              <InspectorItem label="Session ID"><InspectorCodeValue value={session?.id ?? '未选择'} /></InspectorItem>
              <InspectorItem label="项目目录"><InspectorCodeValue value={session?.cwd ?? '当前不可用'} /></InspectorItem>
              <InspectorItem label="最近更新">{formatUpdatedAt(session?.updatedAt)}</InspectorItem>
              <InspectorItem label="模型"><InspectorCodeValue value={fields.model} /></InspectorItem>
              <InspectorItem label="Thinking"><InspectorUnavailable /></InspectorItem>
              <InspectorItem label="工具">受限模式：已禁用</InspectorItem>
            </dl>
          </section>
        </div>
      </ScrollArea>
    </div>
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
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  )
}

function StatusBadge({ status }: { status: Parameters<typeof sessionStatusLabel>[0] }) {
  const color = status === 'running' || status === 'aborting' ? 'text-warning' : status === 'complete' ? 'text-success' : status === 'error' ? 'text-destructive' : 'text-muted-foreground'
  return <span className={`text-xs font-medium ${color}`}>{sessionStatusLabel(status)}</span>
}
