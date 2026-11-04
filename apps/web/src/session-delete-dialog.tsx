import { useRef, useState } from 'react'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { isRunActive, type SessionRunSummary } from './session-run-model.js'
import { sessionDisplayName, type PiSessionSummary } from './workspace.js'
import { useWorkspaceStore } from './workspace-store.js'

export function SessionDeleteDialog({ session, run, mutationSessionId, onDelete, onClose, onCloseAutoFocus }: {
  session: PiSessionSummary; run?: SessionRunSummary; mutationSessionId?: string
  onDelete: (id: string) => Promise<void>; onClose: () => void; onCloseAutoFocus?: (event: Event) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const notification = useWorkspaceStore((state) => state.sessionNotifications[session.id])
  const busy = pending || mutationSessionId === session.id
  const blocked = busy || isRunActive(run?.status ?? (notification?.pendingRunId ? 'running' : 'idle'))
  async function confirm() {
    if (blocked || inFlight.current) return
    inFlight.current = true
    setPending(true); setError(undefined)
    try { await onDelete(session.id); onClose() }
    catch (cause) { setError(cause instanceof Error ? `删除失败：${cause.message}` : '删除失败，请稍后重试。') }
    finally { inFlight.current = false; setPending(false) }
  }
  return <AlertDialog open onOpenChange={(open) => { if (!open && !inFlight.current) onClose() }}>
    <AlertDialogContent onOpenAutoFocus={(event) => { event.preventDefault(); button.current?.focus() }} onCloseAutoFocus={onCloseAutoFocus}>
      <AlertDialogTitle>删除原生 Pi 会话？</AlertDialogTitle>
      <AlertDialogDescription>将删除“{sessionDisplayName(session)}”。优先移入系统废纸篓；若废纸篓不可用，会永久删除原生会话文件且无法恢复。</AlertDialogDescription>
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <AlertDialogCancel asChild><Button disabled={busy} type="button" variant="secondary">取消</Button></AlertDialogCancel>
        <Button ref={button} disabled={blocked} onClick={() => void confirm()} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat && !event.nativeEvent.isComposing) void confirm() } }} type="button" variant="destructive">{pending ? '删除中…' : '删除会话'}</Button>
      </div>
    </AlertDialogContent>
  </AlertDialog>
}
