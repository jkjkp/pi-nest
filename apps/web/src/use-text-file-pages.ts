import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TextFilePage, TextFilePageRequest } from '@pi-nest/contracts'
import { fetchTextFilePage, fetchTextFileStat, type TextFileSource } from './text-file-api.js'
import { useWorkspaceStore } from './workspace-store.js'

const markdownBytes = 1024 * 1024
const cacheBytes = 2 * 1024 * 1024
export function useTextFilePages(source: TextFileSource, positionKey: string, line: number | undefined, navigation: number) {
  const sourceJson = JSON.stringify(source)
  const [initialPosition] = useState(() => useWorkspaceStore.getState().fileReadingPositions[positionKey])
  const appliedNavigation = useRef(initialPosition?.navigation)
  const [page, setPage] = useState<TextFilePage>()
  const [error, setError] = useState('')
  const [changed, setChanged] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const current = useRef<TextFilePage>(undefined)
  const cache = useRef(new Map<string, TextFilePage>())
  const main = useRef<AbortController>(undefined)
  const prefetch = useRef<{ controller: AbortController; key: string; promise: Promise<TextFilePage> }>(undefined)
  const generation = useRef(0)
  const scheduled = useRef(0)
  const lastRequest = useRef<{ request: TextFilePageRequest; restore: boolean; markdown: boolean }>({ request: {}, restore: false, markdown: false })

  const rememberPage = useCallback((result: TextFilePage) => {
    const key = JSON.stringify(result.cursor)
    cache.current.delete(key); cache.current.set(key, result)
    let bytes = [...cache.current.values()].reduce((sum, page) => sum + new TextEncoder().encode(page.text).length, 0)
    while (cache.current.size > 8 || bytes > cacheBytes) {
      const key = cache.current.keys().next().value!
      bytes -= new TextEncoder().encode(cache.current.get(key)!.text).length
      cache.current.delete(key)
    }
  }, [])
  const read = useCallback(async (request: TextFilePageRequest, signal: AbortSignal, report: boolean): Promise<TextFilePage> => {
    let result = await fetchTextFilePage(JSON.parse(sourceJson), request, signal)
    while (result.kind === 'seeking') {
      signal.throwIfAborted()
      if (report) setProgress(`正在定位：已扫描 ${result.cursor.line.toLocaleString()} 行 / ${(result.cursor.offset / 1_048_576).toFixed(1)} MiB…`)
      result = await fetchTextFilePage(JSON.parse(sourceJson), { ...request, cursor: result.cursor }, signal)
    }
    signal.throwIfAborted()
    return result
  }, [sourceJson])
  const load = useCallback(async (request: TextFilePageRequest = {}, restore = false, markdown = false) => {
    lastRequest.current = { request, restore, markdown }
    main.current?.abort()
    const controller = new AbortController(); main.current = controller
    const revision = ++generation.current
    try {
      controller.signal.throwIfAborted()
      setLoading(true); setError(''); setProgress('正在读取文件…')
      const key = request.cursor && JSON.stringify(request.cursor)
      let result = request.targetLine ? [...cache.current.values()].find(page => page.cursor.line <= request.targetLine! && page.lastLine >= request.targetLine! && !page.startsMidLine) : request.direction !== 'previous' && key ? cache.current.get(key) : undefined
      if (!result && prefetch.current && key === prefetch.current.key && request.direction !== 'previous') result = await prefetch.current.promise
      else prefetch.current?.controller.abort()
      result ??= await read(request, controller.signal, true)
      if (markdown && result.fileBytes <= markdownBytes && /\.(md|markdown)$/i.test(source.path)) {
        const first = result; const chunks = [result.text]
        while (result.nextCursor) { result = await read({ cursor: result.nextCursor }, controller.signal, true); chunks.push(result.text) }
        result = { ...result, cursor: first.cursor, startsMidLine: false, text: chunks.join('') }
      }
      controller.signal.throwIfAborted()
      if (revision !== generation.current) return
      rememberPage(result)
      const previous = useWorkspaceStore.getState().fileReadingPositions[positionKey]
      useWorkspaceStore.getState().rememberFilePosition(positionKey, { start: restore ? previous?.start ?? 0 : 0, scrollTop: restore ? previous?.scrollTop ?? 0 : 0, scrollLeft: restore ? previous?.scrollLeft ?? 0 : 0, mode: markdown && result.fileBytes <= markdownBytes && /\.(md|markdown)$/i.test(source.path) ? 'reading' : 'source', zoom: 'fit', pageCursor: result.cursor, navigation: request.targetLine ? undefined : previous?.navigation })
      appliedNavigation.current = navigation
      current.current = result; setPage(result); setChanged(false)
    } catch (cause) {
      if (!controller.signal.aborted && revision === generation.current) {
        if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'FILE_VERSION_CHANGED') setChanged(true)
        setError(cause instanceof Error ? cause.message : '读取文件失败，请重试。')
      }
    } finally { if (!controller.signal.aborted && revision === generation.current) setLoading(false) }
  }, [read, rememberPage, positionKey, source.path, navigation])
  const meta = useQuery({
    queryKey: ['session-file-preview', source.sessionId, source.searchRoot, source.path, source.scope, 'stat'],
    queryFn: async ({ signal }) => {
      const data = await fetchTextFileStat(JSON.parse(sourceJson), signal)
      signal.throwIfAborted()
      const displayed = current.current
      if (displayed && data.version !== displayed.version) {
        cache.current.clear(); prefetch.current?.controller.abort()
        const position = useWorkspaceStore.getState().fileReadingPositions[positionKey]
        if (displayed.cursor.offset === 0 && (position?.scrollTop ?? 0) < 48 && (position?.start ?? 0) === 0) void load({}, false, !line)
        else setChanged(true)
      }
      return data
    },
    gcTime: 0, retry: false, refetchInterval: 5000, refetchOnWindowFocus: true,
  })
  useEffect(() => {
    const saved = useWorkspaceStore.getState().fileReadingPositions[positionKey]
    const relocate = !!line && appliedNavigation.current !== navigation
    const revision = ++scheduled.current
    void Promise.resolve().then(() => {
      if (revision === scheduled.current) return load(relocate ? { targetLine: Math.max(1, line - 40) } : { cursor: saved?.pageCursor }, !relocate, !line && saved?.mode !== 'source')
    })
  }, [load, positionKey, line, navigation])
  useEffect(() => () => { scheduled.current++; generation.current++; main.current?.abort(); prefetch.current?.controller.abort(); cache.current.clear() }, [sourceJson])
  const prefetchNext = () => {
    const cursor = current.current?.nextCursor
    if (!cursor || loading || changed) return
    const key = JSON.stringify(cursor)
    if (cache.current.has(key) || prefetch.current?.key === key) return
    prefetch.current?.controller.abort()
    const controller = new AbortController()
    const promise = read({ cursor }, controller.signal, false).then(page => { if (!controller.signal.aborted) rememberPage(page); return page })
    prefetch.current = { controller, key, promise }
    void promise.catch(() => { if (prefetch.current?.promise === promise) prefetch.current = undefined })
  }
  const refresh = () => { cache.current.clear(); prefetch.current?.controller.abort(); prefetch.current = undefined; const saved = useWorkspaceStore.getState().fileReadingPositions[positionKey]; const targetLine = (current.current?.cursor.line ?? saved?.pageCursor?.line ?? Math.max(1, (line ?? 1) - 40)) + (saved?.start ?? 0); void load(targetLine > 1 ? { targetLine } : {}, false, !line); void meta.refetch() }
  const next = () => { if (current.current?.nextCursor && !changed) void load({ cursor: current.current.nextCursor }) }
  const previous = () => {
    const displayed = current.current
    if (!displayed || changed) return
    const cached = [...cache.current.values()].find(page => page.nextCursor?.offset === displayed.cursor.offset && page.version === displayed.version)
    void load({ cursor: cached?.cursor ?? displayed.cursor, ...(cached ? {} : { direction: 'previous' }) })
  }
  return { page, error, changed, loading, progress, metaError: meta.error?.message, refresh, next, previous, prefetchNext, retry: () => void load(lastRequest.current.request, lastRequest.current.restore, lastRequest.current.markdown) }
}
