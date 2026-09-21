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
      <section aria-label="正在加载会话历史" className="space-y-3">
        {Array.from({ length: 3 }, (_, index) => <Skeleton className="h-24" key={index} />)}
      </section>
    )
  }

  if (error) {
    return (
      <section className="border-b pb-6" role="alert">
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
      <section className="border-b pb-6">
        <h2 className="text-sm font-semibold">会话内容</h2>
        <p className="mt-2 text-sm text-muted-foreground">当前活动分支尚无可展示的消息。</p>
      </section>
    )
  }

  return (
    <section className="space-y-3 border-b pb-6">
      <h2 className="text-sm font-semibold">会话内容</h2>
      {history.hasEarlier && (
        <p className="text-xs text-muted-foreground">首版仅展示当前活动分支最近 200 条原生记录。</p>
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
    <article className={assistant ? 'border bg-card p-4' : 'border bg-muted/45 p-3'}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{assistant ? '助手' : '用户'}</span>
        <time dateTime={entry.timestamp}>{formatUpdatedAt(entry.timestamp)}</time>
      </header>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{entry.text}</p>
      {(entry.stopReason || entry.hasOmittedContent) && (
        <footer className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {entry.stopReason && <span>终止原因：{entry.stopReason}</span>}
          {entry.hasOmittedContent && <span>包含未展示的原生内容</span>}
        </footer>
      )}
    </article>
  )
}
