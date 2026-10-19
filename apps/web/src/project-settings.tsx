import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from './workspace-store.js'
import { projectName } from './workspace.js'

export function ProjectSettings() {
  const hidden = useWorkspaceStore((state) => state.hiddenProjectCwds)
  const restore = useWorkspaceStore((state) => state.restoreProject)
  const paths = Object.keys(hidden)
  return <section className="space-y-4 rounded-xl border p-5">
    <h3 className="font-normal">已移除项目（{paths.length}）</h3>
    <p className="text-sm text-muted-foreground">移除仅隐藏此浏览器中的项目入口，不会删除文件夹或 Pi 会话。</p>
    {paths.length === 0 ? <p className="text-sm text-muted-foreground">没有已移除项目。</p> : <ul className="divide-y">{paths.map((cwd) => <li className="flex items-center gap-3 py-4" key={cwd}><FolderOpen aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-normal">{projectName(cwd)}</p><p className="break-all text-xs text-muted-foreground">{cwd}</p></div><Button type="button" size="sm" variant="outline" aria-label={`恢复 ${projectName(cwd)}`} onClick={() => restore(cwd)}>恢复</Button></li>)}</ul>}
  </section>
}
