import { RefreshCw } from 'lucide-react'
import { useTextFilePages } from './use-text-file-pages.js'
import type { WorkspaceFileScope } from '@pi-nest/contracts'
import { previewWorkspaceFile } from './workspace-files-api.js'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { fetchSessionImagePreview } from './workspace-api.js'
import { filePreviewKey, isPreviewImage } from './file-preview-state.js'
import { FilePreviewText } from './file-preview-text.js'
import { FilePreviewImage } from './file-preview-image.js'

export function SessionFilePreview({ sessionId, path, line, searchRoot, navigation = 0, scope, onClose, onOpenFile }: {
  sessionId: string; path: string; line?: number; searchRoot?: string; navigation?: number; scope?: WorkspaceFileScope
  onClose: () => void; onOpenFile?: (path: string, line?: number) => void
}) {
  if (!isPreviewImage(path)) return <TextFilePreview key={filePreviewKey(sessionId, path, searchRoot)} sessionId={sessionId} path={path} line={line} searchRoot={searchRoot} navigation={navigation} scope={scope} onClose={onClose} onOpenFile={onOpenFile} />
  return <ImageFilePreview sessionId={sessionId} path={path} searchRoot={searchRoot} scope={scope} onClose={onClose} />
}
function ImageFilePreview({ sessionId, path, searchRoot, scope, onClose }: { sessionId: string; path: string; searchRoot?: string; scope?: WorkspaceFileScope; onClose: () => void }) {
  const key = filePreviewKey(sessionId, path, searchRoot)
  const query = useQuery({
    queryKey: ['session-file-preview', sessionId, searchRoot, path, scope],
    queryFn: async ({ signal }) => scope ? previewWorkspaceFile(scope, path, true, signal) : { kind: 'image' as const, ...await fetchSessionImagePreview(sessionId, path, signal, searchRoot) },
    gcTime: 0,
    staleTime: 0, retry: false, refetchOnWindowFocus: false,
  })
  return <section className="flex h-full min-h-0 flex-col" aria-label="当前文件预览">
    <header className="shrink-0 space-y-2 border-b p-3"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-normal">当前文件</h2><Button type="button" size="sm" variant="ghost" onClick={onClose}>收起预览</Button></div><p className="break-all text-xs">{query.data?.path ?? path}</p><p className="text-xs text-muted-foreground">只读预览 · 当前内容可能与历史调用不同</p></header>
    {query.isPending && <p role="status" className="p-4 text-sm text-muted-foreground">正在读取文件…</p>}
    {query.isError && <p role="alert" className="break-words p-4 text-sm text-destructive">{query.data ? '刷新失败，仍显示上次读取的内容：' : ''}{query.error.message}<Button className="ml-2" type="button" size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>重试读取</Button></p>}
    {query.data?.kind === 'image' && <FilePreviewImage blob={query.data.blob} path={query.data.path} positionKey={key} />}
  </section>
}

function TextFilePreview(props: { sessionId: string; path: string; searchRoot?: string; scope?: WorkspaceFileScope; line?: number; navigation: number; onClose: () => void; onOpenFile?: (path: string, line?: number) => void }) {
  const key = filePreviewKey(props.sessionId, props.path, props.searchRoot)
  const view = useTextFilePages({ sessionId: props.sessionId, path: props.path, searchRoot: props.searchRoot, scope: props.scope }, key, props.line, props.navigation)
  const page = view.page
  const markdown = /\.(md|markdown)$/i.test(props.path)
  const reading = markdown && !props.line && page?.eof && page.cursor.offset === 0 && page.fileBytes <= 1_048_576
  return <section className="flex h-full min-h-0 flex-col" aria-label="当前文件预览">
    <header className="shrink-0 space-y-2 border-b p-3"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-normal">当前文件</h2><div className="flex items-center gap-1"><Button type="button" size="icon-sm" variant="ghost" aria-label="刷新文件" disabled={view.loading} onClick={view.refresh}><RefreshCw /></Button><Button type="button" size="sm" variant="ghost" onClick={props.onClose}>收起预览</Button></div></div><p className="break-all text-xs">{page?.path ?? props.path}</p><p className="text-xs text-muted-foreground">只读预览 · 当前内容可能与历史调用不同</p></header>
    {view.loading && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{view.progress}</p>}
    {view.changed && <p role="status" className="px-3 py-2 text-xs text-warning">文件已更新，当前内容保留。请刷新后继续读取。<Button size="sm" variant="ghost" onClick={view.refresh}>重新加载</Button></p>}
    {view.error && <p role="alert" className="break-words p-3 text-sm text-destructive">{page ? '读取失败，仍显示上次读取的内容：' : ''}{view.error}<Button className="ml-2" size="sm" variant="ghost" disabled={view.loading} onClick={view.retry}>重试读取</Button></p>}
    {view.metaError && page && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">无法检查文件更新：{view.metaError}</p>}
    {markdown && page && page.fileBytes > 1_048_576 && <p className="px-3 py-1 text-xs text-muted-foreground">文件较大，已使用分页源码预览。</p>}
    {page && <FilePreviewText key={`${page.version}:${page.cursor.offset}:${props.navigation}`} content={page.text} path={props.scope ? props.path : page.path} line={props.line} navigation={props.navigation} positionKey={key} onOpenFile={props.onOpenFile} pageInfo={reading ? undefined : { ...page, onNext: view.next, onPrevious: view.previous, prefetchNext: view.prefetchNext, loading: view.loading, changed: view.changed }} />}
    {page && !reading && <p className="shrink-0 px-3 py-1 text-xs text-muted-foreground">已读取至 {page.endOffset.toLocaleString()} B / {page.fileBytes.toLocaleString()} B</p>}
  </section>
}
