import { useLayoutEffect, useRef, useState } from 'react'
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
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false,
  })
  const [copyStatus, setCopyStatus] = useState('')
  const mounted = useRef(true)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return <section className="flex h-full min-h-0 flex-col" aria-label="当前文件预览">
    <header className="shrink-0 space-y-2 border-b p-3"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">当前文件</h2><Button type="button" size="sm" variant="ghost" onClick={onClose}>收起预览</Button></div><p className="break-all text-xs">{query.data?.path ?? path}</p><p className="text-xs text-muted-foreground">只读预览 · 当前内容可能与历史调用不同</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching && query.data ? '刷新中…' : query.isError ? '重试读取' : '刷新文件'}</Button><Button type="button" size="sm" variant="ghost" onClick={async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
        await navigator.clipboard.writeText(query.data?.path ?? path)
        if (mounted.current) setCopyStatus('路径已复制')
      } catch { if (mounted.current) setCopyStatus('复制失败，请检查剪贴板权限后重试。') }
    }}>复制路径</Button></div>{copyStatus && <p role="status" className="text-xs text-muted-foreground">{copyStatus}</p>}</header>
    {query.isPending && <p role="status" className="p-4 text-sm text-muted-foreground">正在读取文件…</p>}
    {query.isError && <p role="alert" className="break-words p-4 text-sm text-destructive">{query.data ? '刷新失败，仍显示上次读取的内容：' : ''}{query.error.message}</p>}
    {query.data?.kind === 'text' && <FilePreviewText content={query.data.content} path={query.data.path} line={line} navigation={navigation} positionKey={key} onOpenFile={onOpenFile} />}
    {query.data?.kind === 'image' && <FilePreviewImage blob={query.data.blob} path={query.data.path} positionKey={key} />}
  </section>
}
