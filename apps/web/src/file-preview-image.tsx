import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from './workspace-store.js'
import type { FileReadingPosition } from './file-preview-state.js'

export function FilePreviewImage({ blob, path, positionKey }: { blob: Blob; path: string; positionKey: string }) {
  const [saved] = useState(() => useWorkspaceStore.getState().fileReadingPositions[positionKey])
  const position = useRef<FileReadingPosition>(saved ?? { start: 0, scrollTop: 0, scrollLeft: 0, mode: 'source', zoom: 'fit' })
  const [decoded, setDecoded] = useState<{ blob: Blob; width: number; failed?: boolean }>()
  const [zoom, setZoom] = useState<number | 'fit'>(saved?.zoom ?? 'fit')
  const scroll = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const loaded = decoded?.blob === blob && !decoded.failed
  const failed = decoded?.blob === blob && decoded.failed
  useEffect(() => {
    const source = URL.createObjectURL(blob)
    if (image.current) image.current.src = source
    return () => URL.revokeObjectURL(source)
  }, [blob])
  useLayoutEffect(() => {
    position.current.zoom = zoom
    useWorkspaceStore.getState().rememberFilePosition(positionKey, { ...position.current })
    if (!loaded || !scroll.current) return
    scroll.current.scrollTop = position.current.scrollTop
    scroll.current.scrollLeft = position.current.scrollLeft
  }, [loaded, zoom, positionKey])
  return <>
    <div role="group" aria-label="图片缩放" className="flex shrink-0 flex-wrap items-center gap-1 border-b p-2">
      <Button type="button" size="sm" variant={zoom === 'fit' ? 'secondary' : 'ghost'} onClick={() => setZoom('fit')}>适应面板</Button>
      <Button type="button" size="sm" variant={zoom === 1 ? 'secondary' : 'ghost'} onClick={() => setZoom(1)}>原始尺寸</Button>
      <Button type="button" size="sm" variant="ghost" aria-label="缩小图片" disabled={!loaded || (zoom !== 'fit' && zoom <= 0.1)} onClick={() => setZoom(Math.max(0.1, Number(((zoom === 'fit' ? (image.current!.clientWidth / image.current!.naturalWidth) : zoom) / 1.25).toFixed(3))))}>−</Button>
      <Button type="button" size="sm" variant="ghost" aria-label="放大图片" disabled={!loaded || (zoom !== 'fit' && zoom >= 4)} onClick={() => setZoom(Math.min(4, Number(((zoom === 'fit' ? (image.current!.clientWidth / image.current!.naturalWidth) : zoom) * 1.25).toFixed(3))))}>+</Button>
      <span className="text-xs text-muted-foreground">{zoom === 'fit' ? '适应' : `${Math.round(zoom * 100)}%`}</span>
    </div>
    {failed && <p role="alert" className="p-4 text-sm text-destructive">图片解码失败或像素过大，请刷新文件重试。</p>}<div ref={scroll} className="min-h-0 flex-1 overflow-auto p-3" aria-label="图片预览" tabIndex={0} onScroll={(event) => {
      position.current.scrollTop = event.currentTarget.scrollTop
      position.current.scrollLeft = event.currentTarget.scrollLeft
      useWorkspaceStore.getState().rememberFilePosition(positionKey, { ...position.current })
    }}>
      {!loaded && !failed && <p role="status" className="text-sm text-muted-foreground">正在加载图片…</p>}
      <img ref={image} alt={path} className={zoom === 'fit' ? 'block max-h-full max-w-full object-contain' : 'block max-w-none'} style={{ width: zoom === 'fit' ? undefined : `${(decoded?.width ?? 0) * zoom}px`, visibility: loaded ? 'visible' : 'hidden' }} onLoad={(event) => {
        const node = event.currentTarget
        if (!node.naturalWidth || !node.naturalHeight || node.naturalWidth * node.naturalHeight > 40_000_000) { setDecoded({ blob, width: 0, failed: true }); return }
        setDecoded({ blob, width: node.naturalWidth })
      }} onError={() => setDecoded({ blob, width: 0, failed: true })} />
    </div>
  </>
}
