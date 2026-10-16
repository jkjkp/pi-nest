import { useId, useState } from 'react'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { sessionDisplayName, type PiSessionSummary } from './workspace.js'

export function SessionRenameDialog({ session, onClose, onRename, onCloseAutoFocus }: { session: PiSessionSummary; onClose: () => void; onRename: (id: string, name: string) => Promise<void>; onCloseAutoFocus?: (event: Event) => void }) {
  const inputId = useId()
  const [name, setName] = useState(session.name ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  async function save() {
    if (saving || !name.trim()) return
    setSaving(true)
    setError(undefined)
    try { await onRename(session.id, name.trim()); onClose() }
    catch { setError('重命名失败，请刷新后重试。') }
    finally { setSaving(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
    <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
      <DialogTitle>重命名会话</DialogTitle>
      <DialogDescription>名称会作为 Pi 原生会话元数据保存，Pi CLI 也可读取。</DialogDescription>
      <form onSubmit={(event) => { event.preventDefault(); void save() }}>
        <label className="mt-4 grid gap-2 text-sm font-medium" htmlFor={inputId}>会话名称
          <input className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50" id={inputId} maxLength={120} disabled={saving} onChange={(event) => setName(event.target.value)} placeholder={sessionDisplayName(session)} value={name} />
        </label>
        {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild><Button disabled={saving} type="button" variant="secondary">取消</Button></DialogClose>
          <Button disabled={saving || !name.trim()} type="submit">{saving ? '保存中…' : '保存名称'}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
}
