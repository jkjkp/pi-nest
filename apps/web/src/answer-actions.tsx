import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function AnswerActions({ text, onBranch }: { text: string; onBranch?: () => Promise<void> }) {
  const [toast, setToast] = useState<{ message: string }>()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(undefined), 1000)
    return () => clearTimeout(timer)
  }, [toast])

  async function run(action: () => Promise<void>, failureMessage: string) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setToast(undefined)
    try { await action() }
    catch { setToast({ message: failureMessage }) }
    finally { inFlight.current = false; setBusy(false) }
  }

  return <div className="text-[15px]">
    <div role="group" aria-label="回复操作" className="flex items-center gap-1 text-muted-foreground">
      <Button type="button" variant="ghost" size="icon-sm" className="border-0 text-[length:inherit]" aria-label="复制回复" title="复制回复" disabled={busy} onClick={() => void run(async () => {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
        await navigator.clipboard.writeText(text)
      }, '复制失败')}><Copy aria-hidden="true" className="size-[1em]" /></Button>
      <Button type="button" variant="ghost" size="icon-sm" className="border-0 text-[length:inherit]" aria-label="分支到聊天" title={onBranch ? '分支到聊天' : '请等待会话空闲且历史同步完成后再创建分支'} disabled={busy || !onBranch} onClick={() => { if (onBranch) void run(onBranch, '分支失败') }}><GitBranch aria-hidden="true" className="size-[1em]" /></Button>
    </div>
    {toast && createPortal(<div role="alert" className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-lg">{toast.message}</div>, document.body)}
  </div>
}
