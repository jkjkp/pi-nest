import { useId, useState } from 'react'
import { FolderOpen, FolderPlus } from 'lucide-react'
import type { PiProject } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { addProject } from './workspace-api.js'
import type { ProjectSessionGroup } from './workspace.js'

export function ProjectHome({ projects, loading, error, onRetry, onProjectAdded, onOpen }: {
  projects: ProjectSessionGroup[]
  loading: boolean
  error: boolean
  onRetry: () => void
  onProjectAdded: (project: PiProject) => void
  onOpen: (project: ProjectSessionGroup) => void
}) {
  const [mode, setMode] = useState<'open' | 'create'>()
  return <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-8 sm:py-16">
    <h2 className="text-2xl font-semibold">从项目开始</h2>
    <p className="mt-2 text-sm text-muted-foreground">打开已有文件夹，或创建一个新项目。</p>
    <div className="mt-8 grid gap-3 sm:grid-cols-2">
      <Button className="h-24 justify-start gap-4 px-6 text-base" variant="outline" onClick={() => setMode('open')}><FolderOpen aria-hidden="true" />打开项目</Button>
      <Button className="h-24 justify-start gap-4 px-6 text-base" variant="outline" onClick={() => setMode('create')}><FolderPlus aria-hidden="true" />新建项目</Button>
    </div>
    <div className="mt-10 flex items-center justify-between"><h3 className="text-sm font-medium">已有项目</h3>{error && <Button variant="ghost" size="sm" onClick={onRetry}>重新加载</Button>}</div>
    {loading && <p className="mt-4 text-sm text-muted-foreground" role="status">正在读取项目…</p>}
    {error && <p className="mt-4 text-sm text-destructive" role="alert">部分项目无法读取，请重试。</p>}
    {!loading && !error && projects.length === 0 && <p className="mt-4 text-sm text-muted-foreground">还没有项目，打开一个文件夹开始。</p>}
    <div className="mt-3 grid gap-2">{projects.map((project) => <Button key={project.key} disabled={!project.cwd} className="h-auto min-h-16 justify-start px-4 py-3 text-left" variant="ghost" onClick={() => onOpen(project)}><FolderOpen aria-hidden="true" className="shrink-0" /><span className="min-w-0"><span className="block truncate">{project.name}</span><span className="block truncate text-xs font-normal text-muted-foreground" title={project.cwd}>{project.cwd ?? '工作目录不可用'}</span></span></Button>)}</div>
    {mode && <ProjectDialog key={mode} mode={mode} onClose={() => setMode(undefined)} onAdded={onProjectAdded} />}
  </div>
}

function ProjectDialog({ mode, onClose, onAdded }: { mode: 'open' | 'create'; onClose: () => void; onAdded: (project: PiProject) => void }) {
  const id = useId()
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  async function submit() {
    if (saving || !path.trim() || mode === 'create' && !name.trim()) return
    setSaving(true)
    setError(undefined)
    try {
      const project = await addProject(mode === 'open' ? { kind: 'open', cwd: path.trim() } : { kind: 'create', parent: path.trim(), name: name.trim() })
      onAdded(project)
      onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '项目操作失败，请重试。'); setSaving(false) }
  }
  const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}><DialogContent>
    <DialogTitle>{mode === 'open' ? '打开项目' : '新建项目'}</DialogTitle>
    <DialogDescription>请输入运行 Pi Nest 的电脑上的文件夹绝对路径。</DialogDescription>
    <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label className="grid gap-2 text-sm font-medium" htmlFor={`${id}-path`}>{mode === 'open' ? '文件夹路径' : '父文件夹路径'}<input className={inputClass} id={`${id}-path`} value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/yourname/projects" maxLength={4096} disabled={saving} required /></label>
      {mode === 'create' && <label className="grid gap-2 text-sm font-medium" htmlFor={`${id}-name`}>项目名称<input className={inputClass} id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} placeholder="my-project" maxLength={255} disabled={saving} required /></label>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex justify-end gap-2"><DialogClose asChild><Button type="button" variant="secondary" disabled={saving}>取消</Button></DialogClose><Button type="submit" disabled={saving || !path.trim() || mode === 'create' && !name.trim()}>{saving ? '处理中…' : mode === 'open' ? '打开项目' : '创建项目'}</Button></div>
    </form>
  </DialogContent></Dialog>
}
