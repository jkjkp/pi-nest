import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { AttachmentPicker, ComposerAttachments } from './attachment-ui.js'
import type { useAttachmentDraft } from './attachment-draft.js'
import { useComposerTextarea } from './composer-textarea.js'
import type { MessageEditDraft } from './workspace-store.js'

export function MessageEditor({ edit, attachments, disabled, error, onError, onChange, onCancel, onSubmit }: {
  edit: MessageEditDraft
  attachments: ReturnType<typeof useAttachmentDraft>
  disabled: boolean
  error?: string
  onError: (error: string | undefined) => void
  onChange: (text: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const textarea = useComposerTextarea(edit.text, 448)
  const busy = edit.status !== 'editing'
  const cannotSend = edit.status === 'submitting' || (edit.status === 'editing' && (disabled || attachments.busy || (!edit.text.trim() && !attachments.items.length)))
  useEffect(() => { textarea.current?.focus() }, [textarea])

  return <section aria-label="编辑用户消息" className="w-full min-w-0 rounded-2xl bg-muted p-4 text-foreground">
    <fieldset disabled={busy} className="min-w-0"><ComposerAttachments draft={attachments} /></fieldset>
    <Textarea ref={textarea} aria-label="编辑消息内容" value={edit.text} disabled={busy} maxLength={20_000} rows={2}
      className="min-h-16 resize-none border-0 bg-transparent px-0 py-0 text-[length:calc(15px*var(--font-scale))] leading-[calc(26px*var(--font-scale))] shadow-none focus-visible:ring-0 dark:bg-transparent dark:disabled:bg-transparent"
      onChange={(event) => onChange(event.target.value)}
      onPaste={(event) => {
        const files = [...event.clipboardData.files]
        if (!files.length) return
        event.preventDefault()
        try { attachments.add(files) } catch (cause) { onError(cause instanceof Error ? cause.message : '粘贴失败') }
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel() }
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey) { event.preventDefault(); if (!cannotSend) onSubmit() }
      }} />
    {edit.status !== 'editing' && <p role="status" className="mt-2 text-sm text-muted-foreground">{edit.status === 'submitting' ? '正在提交修改…' : '正在确认发送状态，请勿重复发送'}</p>}
    {(edit.error || error) && <p role="alert" className="mt-2 text-sm text-destructive">{edit.error || error}</p>}
    <div className="mt-3 flex items-center justify-between gap-2">
      <fieldset disabled={busy}><AttachmentPicker draft={attachments} onError={onError} /></fieldset>
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
        <Button type="button" className="bg-foreground text-background hover:bg-foreground/90" disabled={cannotSend} onClick={onSubmit}>{edit.status === 'unknown' ? '确认发送状态' : edit.status === 'submitting' ? '提交中…' : '发送'}</Button>
      </div>
    </div>
  </section>
}
