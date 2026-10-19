import { useId, useState } from 'react'
import { ChevronDown, FilePenLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToolFilePath } from './tool-result-card.js'
import type { TurnFileChange, TurnFileSummaryState } from './turn-execution-model.js'

export function TurnFileSummary({ files, state }: { files: TurnFileChange[]; state: TurnFileSummaryState }) {
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  if (!files.length) return null
  const visible = expanded ? files : files.slice(0, 3)
  return <section aria-label="本轮文件变更" className="mt-4 overflow-hidden rounded-xl border bg-card/50" data-turn-file-summary="" data-execution-toggle="">
    <header className="border-b px-4 py-3">
      <h2 className="flex items-center gap-2 text-sm font-normal"><FilePenLine aria-hidden="true" className="size-4 text-muted-foreground" />文件变更 · {files.length} 个文件</h2>
    </header>
    {state !== 'complete' && <p role="status" className="px-4 pt-3 text-xs text-warning">{state === 'aborted' ? '任务已中断' : '任务执行失败'}，以下为已记录的文件修改。</p>}
    <ul id={listId} className="divide-y px-4">{visible.map((file) => <li key={file.path} className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-sm">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1"><ToolFilePath path={file.path} label={file.displayPath.split('/').at(-1) || file.displayPath} /><span className="break-all text-xs text-muted-foreground">{file.path}</span>{file.outsideProject && <span className="ml-2 text-xs text-muted-foreground">项目外</span>}</div>
        <span className="text-xs text-muted-foreground">{file.status}</span>
        {file.changes && <span className="shrink-0 font-mono text-xs"><span className="text-success">+{file.changes.added}</span>{' '}<span className="text-destructive">−{file.changes.removed}</span></span>}
      </div>
    </li>)}</ul>
    {files.length > 3 && <Button className="mx-2 mb-2" type="button" size="sm" variant="ghost" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>{expanded ? '收起文件列表' : `再显示 ${files.length - 3} 个文件`}<ChevronDown aria-hidden="true" className={`size-4 ${expanded ? 'rotate-180' : ''}`} /></Button>}

  </section>
}
