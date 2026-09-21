import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

import type { PiSessionHistoryMessage, PiSessionHistoryResponse } from './history.js'
import { formatUpdatedAt } from './workspace.js'

export function SessionTimeline({
  error,
  history,
  isLoading,
  onRetry,
}: {
  error: boolean
  history: PiSessionHistoryResponse | undefined
  isLoading: boolean
  onRetry: () => void
}) {
  if (isLoading) {
    return (
      <section aria-label="正在加载会话历史" className="space-y-7">
        {Array.from({ length: 3 }, (_, index) => <Skeleton className="h-20 max-w-2xl" key={index} />)}
      </section>
    )
  }

  if (error) {
    return (
      <section className="rounded-lg border border-destructive/30 border-l-2 border-l-destructive bg-destructive/5 p-4" role="alert">
        <h2 className="text-sm font-semibold">无法读取会话历史</h2>
        <p className="mt-2 text-sm text-muted-foreground">历史仍保留在本机原生会话中；请刷新后重试。</p>
        <Button className="mt-3" onClick={onRetry} size="sm" type="button" variant="secondary">
          重试
        </Button>
      </section>
    )
  }

  if (!history) return null

  if (history.entries.length === 0) {
    return (
      <section className="py-8 text-center">
        <p className="text-sm text-muted-foreground">当前活动分支尚无可展示的消息。</p>
      </section>
    )
  }

  return (
    <section className="space-y-7 pb-6">
      {history.hasEarlier && (
        <p className="rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">当前仅展示最近 200 条原生消息。</p>
      )}
      {history.entries.map((entry, index) =>
        entry.kind === 'omitted' ? (
          <div className="border-l-2 border-muted px-3 py-2 text-xs text-muted-foreground" key={`${entry.timestamp}-${index}`}>
            {entry.label}（连续 {entry.count} 条）
          </div>
        ) : (
          <TimelineMessage entry={entry} key={entry.id} />
        ),
      )}
    </section>
  )
}

function TimelineMessage({ entry }: { entry: PiSessionHistoryMessage }) {
  const assistant = entry.role === 'assistant'
  return (
    <article className={assistant ? 'max-w-3xl' : 'ml-auto max-w-[72%] rounded-[10px] bg-muted/75 px-4 py-3'}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className={`font-medium ${assistant ? assistantStatusClass(entry.stopReason) : 'text-foreground'}`}>
          {assistant ? assistantStatusLabel(entry.stopReason) : '用户'}
        </span>
        <span aria-hidden="true">·</span>
        <time dateTime={entry.timestamp}>{formatUpdatedAt(entry.timestamp)}</time>
      </header>
      <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-7">{entry.text}</p>
      {(entry.stopReason || entry.hasOmittedContent) && (
        <footer className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {entry.stopReason && <span>终止原因：{entry.stopReason}</span>}
          {entry.hasOmittedContent && <span>包含未展示的原生内容</span>}
        </footer>
      )}
    </article>
  )
}

function assistantStatusLabel(stopReason?: string) {
  if (stopReason === 'aborted') return '— 已中止'
  if (stopReason === 'error') return '× 请求失败'
  return '✓ 已完成'
}

function assistantStatusClass(stopReason?: string) {
  if (stopReason === 'aborted') return 'text-muted-foreground'
  if (stopReason === 'error') return 'text-destructive'
  return 'text-success'
}
