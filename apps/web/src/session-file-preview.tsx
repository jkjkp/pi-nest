import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { fetchSessionFilePreview, fetchSessionImagePreview } from './workspace-api.js'
import { filePreviewKey, isPreviewImage } from './file-preview-state.js'
import { FilePreviewText } from './file-preview-text.js'
import { FilePreviewImage } from './file-preview-image.js'

export function SessionFilePreview({ sessionId, path, line, searchRoot, navigation = 0, onClose, onOpenFile }: {
  sessionId: string; path: string; line?: number; searchRoot?: string; navigation?: number
  onClose: () => void; onOpenFile?: (path: string, line?: number) => void
}) {
  const key = filePreviewKey(sessionId, path, searchRoot)
  const query = useQuery({
    queryKey: ['session-file-preview', sessionId, searchRoot, path],
    queryFn: async ({ signal }) => isPreviewImage(path)
      ? { kind: 'image' as const, ...await fetchSessionImagePreview(sessionId, path, signal, searchRoot) }
      : { kind: 'text' as const, ...await fetchSessionFilePreview(sessionId, path, signal, searchRoot) },
    staleTime: 0, retry: false, refetchOnWindowFocus: false,
  })
  return <section className="flex h-full min-h-0 flex-col" aria-label="当前文件预览">
    <header className="shrink-0 space-y-2 border-b p-3"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-normal">当前文件</h2><Button type="button" size="sm" variant="ghost" onClick={onClose}>收起预览</Button></div><p className="break-all text-xs">{query.data?.path ?? path}</p><p className="text-xs text-muted-foreground">只读预览 · 当前内容可能与历史调用不同</p></header>
    {query.isPending && <p role="status" className="p-4 text-sm text-muted-foreground">正在读取文件…</p>}
    {query.isError && <p role="alert" className="break-words p-4 text-sm text-destructive">{query.data ? '刷新失败，仍显示上次读取的内容：' : ''}{query.error.message}<Button className="ml-2" type="button" size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>重试读取</Button></p>}
    {query.data?.kind === 'text' && <FilePreviewText content={query.data.content} path={query.data.path} line={line} navigation={navigation} positionKey={key} onOpenFile={onOpenFile} />}
    {query.data?.kind === 'image' && <FilePreviewImage blob={query.data.blob} path={query.data.path} positionKey={key} />}
  </section>
}
