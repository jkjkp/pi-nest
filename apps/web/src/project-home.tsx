import { useState } from 'react'
import { FolderOpen, FolderPlus } from 'lucide-react'
import type { PiProject } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { ProjectDialog } from './project-dialog.js'
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
    <h2 className="text-2xl font-normal">从项目开始</h2>
    <p className="mt-2 text-sm text-muted-foreground">打开已有文件夹，或创建一个新项目。</p>
    <div className="mt-8 grid gap-3 sm:grid-cols-2">
      <Button className="h-24 justify-start gap-4 px-6 text-base" variant="outline" onClick={() => setMode('open')}><FolderOpen aria-hidden="true" />打开项目</Button>
      <Button className="h-24 justify-start gap-4 px-6 text-base" variant="outline" onClick={() => setMode('create')}><FolderPlus aria-hidden="true" />新建项目</Button>
    </div>
    <div className="mt-10 flex items-center justify-between"><h3 className="text-sm font-normal">已有项目</h3>{error && <Button variant="ghost" size="sm" onClick={onRetry}>重新加载</Button>}</div>
    {loading && <p className="mt-4 text-sm text-muted-foreground" role="status">正在读取项目…</p>}
    {error && <p className="mt-4 text-sm text-destructive" role="alert">部分项目无法读取，请重试。</p>}
    {!loading && !error && projects.length === 0 && <p className="mt-4 text-sm text-muted-foreground">还没有项目，打开一个文件夹开始。</p>}
    <div className="mt-3 grid gap-2">{projects.map((project) => <Button key={project.key} disabled={!project.cwd} className="h-auto min-h-16 justify-start px-4 py-3 text-left" variant="ghost" onClick={() => onOpen(project)}><FolderOpen aria-hidden="true" className="shrink-0" /><span className="min-w-0"><span className="block truncate">{project.name}</span><span className="block truncate text-xs font-normal text-muted-foreground" title={project.cwd}>{project.cwd ?? '工作目录不可用'}</span></span></Button>)}</div>
    {mode && <ProjectDialog key={mode} mode={mode} onClose={() => setMode(undefined)} onAdded={onProjectAdded} />}
  </div>
}
