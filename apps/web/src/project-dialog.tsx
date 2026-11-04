import { useEffect, useId, useRef, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import type { PiProject } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { addProject, selectProjectFolder } from './workspace-api.js'

export function ProjectDialog({ mode, onClose, onAdded }: { mode: 'open' | 'create' | 'register'; onClose: () => void; onAdded: (project: PiProject) => void }) {
  const id = useId()
  const [path, setPath] = useState('')
  const [source, setSource] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const picker = useRef<AbortController>(undefined)
  useEffect(() => () => { const controller = picker.current; picker.current = undefined; controller?.abort() }, [])
  const registering = mode === 'register'
  const cwd = (registering ? source : path).trim()
  const ready = Boolean(cwd && !choosing && (mode !== 'create' || name.trim()))
  async function submit() {
    if (saving || !ready) return
    setSaving(true)
    setError(undefined)
    try {
      const project = await addProject(mode === 'create' ? { kind: 'create', parent: cwd, name: name.trim() } : { kind: 'open', cwd })
      onAdded(project)
      onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '项目操作失败，请重试。'); setSaving(false) }
  }
  async function chooseSource() {
    if (picker.current || saving) return
    const controller = new AbortController()
    picker.current = controller
    const timeout = setTimeout(() => controller.abort(new DOMException('选择超时', 'TimeoutError')), 120_000)
    controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true })
    setChoosing(true)
    setError(undefined)
    try {
      const selected = await selectProjectFolder(source.trim() || undefined, controller.signal)
      if (picker.current === controller && !controller.signal.aborted && selected !== null) setSource(selected)
    } catch (cause) {
      if (picker.current === controller && (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError')) setError(controller.signal.aborted ? '文件夹选择已超时，请重试或手动输入绝对路径。' : cause instanceof Error ? cause.message : '无法选择文件夹，请重试。')
    } finally {
      clearTimeout(timeout)
      if (picker.current === controller) { picker.current = undefined; setChoosing(false) }
    }
  }
  function cancelChoosing() {
    const controller = picker.current
    picker.current = undefined
    controller?.abort()
    setChoosing(false)
  }
  function close() {
    cancelChoosing()
    onClose()
  }
  const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) close() }}><DialogContent className={`max-h-[calc(100dvh-2rem)] overflow-y-auto ${registering ? 'w-[min(40rem,calc(100vw-2rem))] rounded-2xl p-6' : ''}`}>
    <div className="flex items-center justify-between gap-4"><DialogTitle>{registering ? '创建项目' : mode === 'open' ? '打开项目' : '新建项目'}</DialogTitle><DialogClose asChild><Button aria-label="关闭" size="icon-sm" variant="ghost" disabled={saving}><X aria-hidden="true" /></Button></DialogClose></div>
    <DialogDescription>{registering ? '选择一个源文件夹，开始项目中的对话。' : '请输入运行 Pi Nest 的电脑上的文件夹绝对路径。'}</DialogDescription>
    <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {registering ? <section aria-label="源文件夹" className="space-y-3">
        <h3 className="text-sm font-normal">源文件夹</h3>
        <div className="flex min-h-44 flex-col justify-center gap-4 rounded-xl border bg-muted/20 p-5">
          {source ? <div className="flex min-w-0 flex-wrap items-center gap-3"><FolderOpen aria-hidden="true" className="shrink-0" /><span className="min-w-0 flex-1 break-all text-sm">{source}</span><Button type="button" size="sm" variant="secondary" disabled={saving || choosing} onClick={() => void chooseSource()}>{choosing ? '选择中…' : '重新选择'}</Button><Button aria-label="移除源文件夹" type="button" size="icon-sm" variant="ghost" disabled={saving || choosing} onClick={() => { setSource(''); setError(undefined) }}><X aria-hidden="true" /></Button></div> : <div className="space-y-4 text-center"><p className="text-sm text-muted-foreground">在此电脑上选择文件夹</p><Button className="rounded-full" type="button" variant="secondary" disabled={saving || choosing} onClick={() => void chooseSource()}><FolderOpen aria-hidden="true" />{choosing ? '选择中…' : '选择文件夹'}</Button></div>}
        </div>
        {choosing && <div className="flex items-center justify-between gap-3"><p role="status" className="text-sm text-muted-foreground">请在系统窗口中选择文件夹；看不到窗口时可取消选择。</p><Button type="button" size="sm" variant="ghost" onClick={cancelChoosing}>取消选择</Button></div>}
        <label className="grid gap-2 text-sm font-normal" htmlFor={`${id}-source`}>或输入文件夹绝对路径<input className={inputClass} id={`${id}-source`} value={source} onChange={(event) => setSource(event.target.value)} placeholder="C:\Users\yourname\projects 或 /Users/yourname/projects" maxLength={4096} disabled={saving || choosing} /></label>
        <p className="text-xs text-muted-foreground">路径位于运行 Pi Nest 的电脑上。</p>
      </section> : <label className="grid gap-2 text-sm font-normal" htmlFor={`${id}-path`}>{mode === 'open' ? '文件夹路径' : '父文件夹路径'}<input className={inputClass} id={`${id}-path`} value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/yourname/projects" maxLength={4096} disabled={saving} required /></label>}
      {mode === 'create' && <label className="grid gap-2 text-sm font-normal" htmlFor={`${id}-name`}>项目名称<input className={inputClass} id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} placeholder="my-project" maxLength={255} disabled={saving} required /></label>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex justify-end gap-2 pt-3"><DialogClose asChild><Button type="button" variant="ghost" disabled={saving}>取消</Button></DialogClose><Button className={registering ? 'rounded-xl px-6' : undefined} type="submit" disabled={saving || !ready}>{saving ? '处理中…' : registering || mode === 'create' ? '创建项目' : '打开项目'}</Button></div>
    </form>
  </DialogContent></Dialog>
}
