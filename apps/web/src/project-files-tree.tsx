import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkspaceFileScope } from '@pi-nest/contracts'
import { ChevronRight, File, Folder, Link, RefreshCw, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from './workspace-store.js'
import { listWorkspaceFiles, watchWorkspaceFiles } from './workspace-files-api.js'
import { openProjectFolder } from './workspace-api.js'

export function ProjectFilesTree({ scope, scopeKey, cwd, onOpenFile }: { scope: WorkspaceFileScope; scopeKey: string; cwd?: string; onOpenFile: (path: string) => void }) {
  const panel = useWorkspaceStore(state => state.filePreviews[scopeKey])!
  const update = useWorkspaceStore(state => state.updateFileTree)
  const client = useQueryClient()
  const scroll = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const cacheKey = cwd ?? JSON.stringify(scope)
  const scopeJson = JSON.stringify(scope)
  const pathsJson = JSON.stringify(['', ...panel.expanded.slice(0, 63)])
  const initialScroll = useRef(panel.scrollTop)
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = initialScroll.current }, [])
  useEffect(() => {
    const controller = new AbortController()
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ['project-files', cacheKey] })
      void client.invalidateQueries({ queryKey: ['session-file-preview', scopeKey] })
    }
    void watchWorkspaceFiles(JSON.parse(scopeJson), JSON.parse(pathsJson), controller.signal, () => { setError(''); refresh() }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '自动刷新不可用，可手动刷新。') })
    window.addEventListener('focus', refresh)
    return () => { controller.abort(); window.removeEventListener('focus', refresh) }
  }, [client, cacheKey, scopeKey, scopeJson, pathsJson])
  function refresh() {
    void client.invalidateQueries({ queryKey: ['project-files', cacheKey] })
    void client.invalidateQueries({ queryKey: ['session-file-preview', scopeKey] })
  }
  return <section className="flex min-h-0 flex-1 flex-col" aria-label="项目文件树">
    <div className="flex items-center gap-2 border-b px-3 py-2"><p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={cwd}>{cwd ?? '项目文件'}</p><Button variant="ghost" size="icon-sm" aria-label="刷新项目文件" onClick={refresh}><RefreshCw /></Button>{cwd && <Button variant="ghost" size="icon-sm" aria-label="在系统文件管理器中打开项目" onClick={() => void openProjectFolder(cwd).catch(cause => setError(cause.message))}><FolderOpen /></Button>}</div>
    {error && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{error}</p>}
    <div ref={scroll} className="min-h-0 flex-1 overflow-auto py-2" onScroll={event => update(scopeKey, { scrollTop: event.currentTarget.scrollTop })}>
      <Directory scope={scope} cacheKey={cacheKey} path="" depth={0} expanded={panel.expanded} toggle={path => update(scopeKey, { expanded: panel.expanded.includes(path) ? panel.expanded.filter(item => item !== path && !item.startsWith(`${path}/`)) : [...panel.expanded, path].slice(-63) })} onOpenFile={onOpenFile} />
    </div>
  </section>
}
function Directory({ scope, cacheKey, path, depth, expanded, toggle, onOpenFile }: { scope: WorkspaceFileScope; cacheKey: string; path: string; depth: number; expanded: string[]; toggle: (path: string) => void; onOpenFile: (path: string) => void }) {
  const query = useInfiniteQuery({ queryKey: ['project-files', cacheKey, path], initialPageParam: 0, queryFn: ({ pageParam, signal }) => listWorkspaceFiles(scope, path, pageParam, signal), getNextPageParam: page => page.nextOffset, retry: false, staleTime: 30_000 })
  if (query.isPending) return <p role="status" className="px-4 py-2 text-xs text-muted-foreground">正在读取目录…</p>
  if (query.isError) return <p role="alert" className="p-3 text-xs text-destructive">{query.error.message}<Button variant="ghost" size="sm" onClick={() => void query.refetch()}>重试</Button></p>
  const entries = query.data.pages.flatMap(page => page.entries)
  return <>
    {!entries.length && <p className="px-4 py-2 text-xs text-muted-foreground">空目录</p>}
    {entries.map(entry => {
      const directory = entry.kind === 'directory'
      const open = expanded.includes(entry.path)
      const Icon = directory ? Folder : entry.kind === 'link' ? Link : File
      return <div key={entry.path}>
        <button type="button" className="flex min-h-8 w-full items-center gap-2 rounded-md py-1 pr-3 text-left text-[13px] hover:bg-muted disabled:opacity-50" style={{ paddingLeft: 12 + depth * 16 }} title={entry.kind === 'link' ? `${entry.path}（符号链接不在文件树中展开）` : entry.path} aria-expanded={directory ? open : undefined} disabled={entry.kind === 'link' || entry.kind === 'other'} onClick={() => directory ? toggle(entry.path) : onOpenFile(entry.path)}>
          <ChevronRight aria-hidden className={`size-3 shrink-0 ${directory ? open ? 'rotate-90' : '' : 'invisible'}`} /><Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{entry.name}</span>
        </button>
        {directory && open && <Directory scope={scope} cacheKey={cacheKey} path={entry.path} depth={depth + 1} expanded={expanded} toggle={toggle} onOpenFile={onOpenFile} />}
      </div>
    })}
    {query.hasNextPage && <Button className="ml-3" size="sm" variant="ghost" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多</Button>}
  </>
}
