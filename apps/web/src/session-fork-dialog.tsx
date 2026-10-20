import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { fetchSessionTurnIndex } from './workspace-api.js'

export function SessionForkDialog({ sessionId, onClose, onFork, onCloseAutoFocus }: { sessionId: string; onClose: () => void; onFork: (entryId: string, revision: string) => Promise<void>; onCloseAutoFocus?: (event: Event) => void }) {
  const inputName = useId()
  const [entryId, setEntryId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const index = useQuery({ queryKey: ['session-fork-entries', sessionId], queryFn: () => fetchSessionTurnIndex(sessionId), retry: false, staleTime: 0, refetchOnWindowFocus: false })
  async function fork() {
    if (!entryId || !index.data || saving || index.isFetching) return
    setSaving(true)
    setError(undefined)
    try { await onFork(entryId, index.data.revision); onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '创建分支失败，请重试。') }
    finally { setSaving(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
    <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
      <DialogTitle>从历史消息创建分支</DialogTitle>
      <DialogDescription>新会话保留所选消息之前的上下文，并将该消息回填到输入框，供修改后发送。原会话保留。</DialogDescription>
      <div className="mt-4 max-h-[45dvh] space-y-1 overflow-y-auto overscroll-contain" aria-label="分叉位置">
        {index.data?.entries.map((entry) => <label key={entry.id} className={`flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm ${entry.id === entryId ? 'bg-accent' : 'hover:bg-accent/60'}`}>
          <input type="radio" name={inputName} value={entry.id} checked={entry.id === entryId} disabled={saving || index.isFetching} onChange={() => setEntryId(entry.id)} className="mt-1 shrink-0" />
          <span className="min-w-0 break-words">{entry.index}. {entry.promptPreview}</span>
        </label>)}
      </div>
      {index.isFetching && <p role="status" className="mt-2 text-sm text-muted-foreground">正在读取分叉位置…</p>}
      {!index.isFetching && !index.isError && index.data?.entries.length === 0 && <p className="mt-2 text-sm text-muted-foreground">当前分支没有可选择的用户消息。</p>}
      {(error || index.isError) && <p role="alert" className="mt-2 text-sm text-destructive">{error ?? '读取分叉位置失败，请重试。'}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={saving || index.isFetching} onClick={() => { setEntryId(''); void index.refetch().then((result) => { if (!result.isError) setError(undefined) }) }}>刷新位置</Button>
        <DialogClose asChild><Button disabled={saving} type="button" variant="secondary">取消</Button></DialogClose>
        <Button type="button" disabled={saving || index.isFetching || index.isError || !index.data?.entries.some((entry) => entry.id === entryId)} onClick={() => void fork()}>{saving ? '创建中…' : '创建分支'}</Button>
      </div>
    </DialogContent>
  </Dialog>
}
