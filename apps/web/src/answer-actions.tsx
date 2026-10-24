import { useRef, useState } from 'react'
import { Check, Copy, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function AnswerActions({ text, onBranch }: { text: string; onBranch?: () => Promise<void> }) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(undefined)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试。') }
    finally { inFlight.current = false; setBusy(false) }
  }

  const copyLabel = copied ? '已复制' : '复制回复'
  return <div className="text-[15px]">
    <div role="group" aria-label="回复操作" className="flex items-center gap-1 text-muted-foreground">
      <Button type="button" variant="ghost" size="icon-sm" className="border-0 text-[length:inherit]" aria-label={copyLabel} title={copyLabel} disabled={busy} onClick={() => void run(async () => {
        if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入。')
        try { await navigator.clipboard.writeText(text) }
        catch { throw new Error('复制失败，请检查浏览器剪贴板权限后重试。') }
        setCopied(true)
      })}>{copied ? <Check aria-hidden="true" className="size-[1em]" /> : <Copy aria-hidden="true" className="size-[1em]" />}</Button>
      <Button type="button" variant="ghost" size="icon-sm" className="border-0 text-[length:inherit]" aria-label="分支到聊天" title={onBranch ? '分支到聊天' : '请等待会话空闲且历史同步完成后再创建分支'} disabled={busy || !onBranch} onClick={() => { if (onBranch) void run(onBranch) }}><GitBranch aria-hidden="true" className="size-[1em]" /></Button>
    </div>
    {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
  </div>
}
