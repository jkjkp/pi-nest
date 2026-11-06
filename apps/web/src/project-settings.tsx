import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen } from 'lucide-react'
import type { PiProject } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { fetchRemovedProjects, restoreProject } from './workspace-api.js'
import { ProjectVisibilityMigration } from './project-visibility-migration.js'
import { projectName } from './workspace.js'

export function ProjectSettings() {
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['projects', 'removed'], queryFn: fetchRemovedProjects, retry: false })
  const projects: PiProject[] = query.data ?? []
  const loading = query.isPending
  const [operationError, setError] = useState<string>()
  const error = operationError ?? query.error?.message
  const [restoring, setRestoring] = useState<string>()
  const busy = useRef(false)
  const reload = () => client.invalidateQueries({ queryKey: ['projects'] })
  async function restore(id: string) {
    if (busy.current) return
    busy.current = true; setRestoring(id); setError(undefined)
    try { await restoreProject(id); await reload() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '恢复失败，请重试。') }
    finally { busy.current = false; setRestoring(undefined) }
  }
  return <div className="space-y-4">
    <ProjectVisibilityMigration />
    <section className="space-y-4 rounded-xl border p-5">
      <div className="flex items-center justify-between gap-3"><h3 className="font-normal">已移除项目（{projects.length}）</h3><Button size="sm" variant="ghost" disabled={loading || Boolean(restoring)} onClick={() => void reload()}>重新加载</Button></div>
      <p className="text-sm text-muted-foreground">移除状态对所有浏览器生效，不会删除文件夹、Pi 会话或停止运行任务。</p>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {loading && <p className="text-sm text-muted-foreground" role="status">正在读取项目…</p>}
      {!loading && !error && projects.length === 0 && <p className="text-sm text-muted-foreground">没有已移除项目。</p>}
      <ul className="divide-y">{projects.map((project) => <li className="flex items-center gap-3 py-4" key={project.id}><FolderOpen aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-normal">{projectName(project.cwd)}</p><p className="break-all text-xs text-muted-foreground">{project.cwd}</p></div><Button type="button" size="sm" variant="outline" disabled={Boolean(restoring)} aria-label={`恢复 ${projectName(project.cwd)}`} onClick={() => void restore(project.id)}>{restoring === project.id ? '正在恢复…' : '恢复'}</Button></li>)}</ul>
    </section>
  </div>
}
