import { useEffect, useRef, useState } from 'react'
import { File, LoaderCircle, Paperclip, X } from 'lucide-react'
import type { AttachmentRef } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { FilePreviewImage } from './file-preview-image.js'
import { FilePreviewText } from './file-preview-text.js'
import { configurationResponse } from './workspace-api.js'
import type { AttachmentScope, useAttachmentDraft } from './attachment-draft.js'

export function MessageAttachments({ attachments, scope }: { attachments: AttachmentRef[]; scope: AttachmentScope }) {
  return <div className="flex max-w-full flex-wrap gap-2" aria-label="消息附件">{attachments.map((attachment, index) => <AttachmentCard key={`${attachment.id}:${index}`} attachment={attachment} scope={scope} imageOnly={attachment.kind === 'image'} />)}</div>
}
function AttachmentCard({ attachment, scope, imageOnly = false }: { attachment: AttachmentRef; scope: AttachmentScope; imageOnly?: boolean }) {
  const [blob, setBlob] = useState<Blob>()
  const [thumbnail, setThumbnail] = useState<Blob>()
  const image = useRef<HTMLImageElement>(null)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string>()
  const root = useRef<HTMLDivElement>(null)
  const scopeKey = JSON.stringify(scope)
  useEffect(() => {
    const controller = new AbortController()
    if (attachment.kind !== 'image') return
    const load = () => { setLoading(true); void configurationResponse(`/api/attachments/${encodeURIComponent(attachment.id)}/content?thumbnail=1`, { method: 'POST', body: scopeKey, signal: controller.signal }).then((r) => r.blob()).then((b) => { if (!controller.signal.aborted) { setThumbnail(b); setError(undefined) } }).catch((e) => { if (!controller.signal.aborted) setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) }) }
    if (typeof IntersectionObserver === 'undefined') load()
    else {
      const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) { observer.disconnect(); load() } }, { rootMargin: '200px' })
      if (root.current) observer.observe(root.current)
      return () => { controller.abort(); observer.disconnect() }
    }
    return () => controller.abort()
  }, [attachment.id, attachment.kind, scopeKey])
  useEffect(() => {
    if (!thumbnail) return
    const next = URL.createObjectURL(thumbnail); if (image.current) image.current.src = next
    return () => URL.revokeObjectURL(next)
  }, [thumbnail])
  async function activate() {
    if (blob) { if (attachment.kind === 'image' || text !== undefined) setOpen(true); else download(blob); return }
    setLoading(true); setError(undefined)
    try {
      const response = await configurationResponse(`/api/attachments/${encodeURIComponent(attachment.id)}/content`, { method: 'POST', body: scopeKey })
      const next = await response.blob()
      setBlob(next)
      if (attachment.kind === 'image') setOpen(true)
      else if (/\.(txt|md|json|csv|ts|tsx|js|jsx|py|css|html|svg|yaml|yml|log)$/i.test(attachment.name) && next.size <= 1024 * 1024) {
        try { const content = new TextDecoder('utf-8', { fatal: true }).decode(await next.arrayBuffer()); if (content.includes('\0')) throw new Error(); setText(content); setOpen(true) }
        catch { download(next) }
      } else download(next)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '附件读取失败') }
    finally { setLoading(false) }
  }
  function download(value: Blob) {
    const href = URL.createObjectURL(value)
    const link = document.createElement('a'); link.href = href; link.download = attachment.name; document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  }
  const previewTitle = <DialogTitle className="truncate" title={attachment.name}>{attachment.name}</DialogTitle>
  const previewClose = <DialogClose asChild><Button aria-label="关闭附件预览" type="button" size="icon-sm" variant="ghost"><X aria-hidden className="size-4" /></Button></DialogClose>
  return <div ref={root} className="max-w-full">
    <button type="button" onClick={() => void activate()} disabled={loading} className={`flex max-w-full items-center gap-2 rounded-lg border bg-background py-2 text-left text-xs hover:bg-accent ${imageOnly ? 'px-2' : 'px-3'}`} aria-label={`打开附件 ${attachment.name}`}>
      {attachment.kind === 'image' ? thumbnail ? <img ref={image} alt={attachment.name} className="size-16 object-contain" /> : <span className="grid size-16 place-items-center">{loading ? <LoaderCircle className="size-4 animate-spin" /> : '图片'}</span> : <File aria-hidden className="size-5 shrink-0" />}
      {!imageOnly && <span className="min-w-0"><span className="block truncate">{attachment.name}</span><span className="text-muted-foreground">{(attachment.size / 1024).toFixed(1)} KiB{attachment.kind === 'file' ? ' · 按需读取' : ''}</span></span>}
    </button>
    {error && <p role="alert" className="max-w-64 text-xs text-destructive">{error}<Button type="button" size="sm" variant="ghost" onClick={() => void activate()}>重试</Button></p>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[85svh] w-[min(64rem,calc(100vw-2rem))]! max-w-5xl! flex-col overflow-hidden">
        <DialogDescription className="sr-only">附件只读预览</DialogDescription>
        {blob && attachment.kind === 'image'
          ? <FilePreviewImage blob={blob} path={attachment.name} positionKey={`attachment:${attachment.id}`} title={previewTitle} actions={previewClose} />
          : <><div className="flex min-w-0 items-center justify-between gap-2">{previewTitle}{previewClose}</div><div className="flex min-h-0 flex-1 flex-col overflow-auto"><FilePreviewText content={text ?? ''} path={attachment.name} navigation={0} positionKey={`attachment:${attachment.id}`} /></div></>}
      </DialogContent>
    </Dialog>
  </div>
}

export function AttachmentPicker({ draft, onError }: { draft: ReturnType<typeof useAttachmentDraft>; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  function add(files: File[]) { try { draft.add(files) } catch (cause) { onError(cause instanceof Error ? cause.message : '无法添加附件') } }
  return <>
    <Button type="button" size="icon-sm" variant="ghost" aria-label="添加附件" className="composer-attachment" data-composer-tooltip="添加附件" onClick={() => input.current?.click()}><Paperclip aria-hidden className="size-4" /></Button>
    <input className="sr-only" ref={input} type="file" multiple aria-label="选择附件" onChange={(event) => { add([...event.currentTarget.files ?? []]); event.currentTarget.value = '' }} />
  </>
}

export function ComposerAttachments({ draft }: { draft: ReturnType<typeof useAttachmentDraft> }) {
  if (draft.items.length === 0) return null
  return <div className="pointer-events-auto mb-2 space-y-2">
    <ul aria-label="待发送附件" className="flex gap-2 overflow-x-auto pb-1">{draft.items.map((item) => <li key={item.id} className={`group/attachment relative flex max-w-72 shrink-0 items-start gap-2 text-xs ${item.ref?.kind === 'image' ? '' : 'min-w-48 rounded-lg border bg-background p-2'}`}>
      <div className="min-w-0 flex-1">
        {item.ref?.kind === 'image' && draft.scope ? <AttachmentCard attachment={item.ref} scope={draft.scope} imageOnly /> : <span className="block truncate" title={item.name}>{item.name}</span>}
        {item.status !== 'ready' && <span role="status" className="text-muted-foreground">{item.status === 'uploading' ? '正在上传…' : item.error}</span>}
        {item.status === 'failed' && <Button size="sm" variant="ghost" onClick={() => void draft.retry(item.id)}>重试</Button>}
      </div>
      <Button aria-label={`移除 ${item.name}`} size="icon-sm" variant="ghost" className={item.ref?.kind === 'image' ? 'pointer-events-none absolute right-1 top-1 bg-background/90 opacity-0 group-hover/attachment:pointer-events-auto group-hover/attachment:opacity-100 group-focus-within/attachment:pointer-events-auto group-focus-within/attachment:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100' : undefined} onClick={() => draft.remove(item.id)}><X aria-hidden className="size-3" /></Button>
    </li>)}</ul>
  </div>
}
