import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchSessionHistory } from './workspace-api.js'
import { fetchSessionNavigation } from './session-navigation-query.js'
import { historyCacheVersion, historyUserTurnCount, mergeSessionHistoryPage, mergeSessionHistoryPages, sessionHistoryQueryKey, sessionTurnIndexQueryKey, type PiSessionHistoryResponse } from './history.js'
import { timelineItems } from './timeline-model.js'

import { fetchHistoryView, type HistoryPages as Pages } from './history-view.js'
import type { TimelineJump } from './timeline-pagination.js'

/** History is a versioned read model, independent of the current generation. */
export function useSessionHistory(sessionId: string, enabled: boolean) {
  const client = useQueryClient()
  const current = useRef(sessionId)
  const jumpSequence = useRef(0)
  const [pendingJump, setPendingJump] = useState<TimelineJump>()
  const [jumpError, setJumpError] = useState<{ sessionId: string; revision?: string; message: string }>()
  const invalidateTurnJump = useCallback(() => { ++jumpSequence.current }, [])
  const cancelTurnJump = useCallback(() => { ++jumpSequence.current; setPendingJump(undefined); setJumpError(undefined) }, [])
  const [paging, setPaging] = useState<string>()
  const [failure, setFailure] = useState<{ sessionId: string; cause: Error }>()
  useEffect(() => {
    current.current = sessionId
    return () => { void client.cancelQueries({ queryKey: ['session-history-page', sessionId] }) }
  }, [client, sessionId])
  const queryKey = sessionHistoryQueryKey(sessionId)
  const query = useQuery<Pages, Error>({
    queryKey, enabled,
    queryFn: ({ signal }) => fetchHistoryView(sessionId, signal, client),
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  })
  const history = useMemo(() => mergeSessionHistoryPages(query.data?.pages), [query.data?.pages])
  const oldestPage = query.data?.pages[0]
  const revision = history?.revision
  const revisionRef = useRef(revision)
  useLayoutEffect(() => {
    current.current = sessionId
    revisionRef.current = revision
    invalidateTurnJump()
    return invalidateTurnJump
  }, [sessionId, revision, invalidateTurnJump])
  const finishTurnJump = useCallback((id: number, error?: string) => {
    if (id !== jumpSequence.current) return
    ++jumpSequence.current
    setPendingJump(undefined)
    setJumpError(error ? { sessionId: current.current, revision: revisionRef.current, message: error } : undefined)
  }, [])
  const index = useQuery({
    queryKey: sessionTurnIndexQueryKey(sessionId, revision),
    queryFn: ({ signal }) => fetchSessionNavigation(sessionId, revision!, signal, client),
    enabled: enabled && Boolean(revision) && !query.isFetching,
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  })
  const readPage = useCallback((before?: string) => client.fetchQuery({
    queryKey: ['session-history-page', sessionId, historyCacheVersion, revision, before],
    queryFn: ({ signal }) => fetchSessionHistory(sessionId, before, revision, signal), staleTime: Infinity,
  }), [client, revision, sessionId])
  const commit = useCallback((page: PiSessionHistoryResponse) => {
    const saved = client.getQueryData<Pages>(sessionHistoryQueryKey(sessionId))
    const savedRevision = saved?.pages.at(-1)?.revision
    if (current.current !== sessionId || revisionRef.current !== revision || saved && savedRevision !== revision || (revision !== undefined && page.revision !== revision)) throw new Error('历史视图已更新，请重试。')
    client.setQueryData<Pages>(sessionHistoryQueryKey(sessionId), (saved) => ({ pages: mergeSessionHistoryPage(saved?.pages, page), pageParams: [...(saved?.pageParams ?? []), { revision }] }))
  }, [client, revision, sessionId])
  async function loadEarlier() {
    if (!oldestPage?.hasEarlier || paging === sessionId) return
    setPaging(sessionId); setFailure(undefined)
    try { commit(await readPage(oldestPage.beforeCursor)) }
    catch (cause) { if (current.current === sessionId) setFailure({ sessionId, cause: cause instanceof Error ? cause : new Error('历史读取失败') }) }
    finally { setPaging(undefined) }
  }
  const readTurnPrompt = useCallback(async (turnId: string, cursor?: string) => {
    const page = await readPage(cursor)
    if (current.current !== sessionId || revisionRef.current !== revision) throw new Error('历史视图已更新，请重试。')
    const prompt = timelineItems(page.entries, [], []).find((turn) => turn.id === turnId)?.prompt
    if (prompt === undefined) throw new Error('未找到用户消息，请重试。')
    return prompt
  }, [readPage, revision, sessionId])
  const requestTurnJump = useCallback(async (turnId: string, cursor?: string, loaded = false) => {
    const operation = ++jumpSequence.current
    const intent: TimelineJump = { id: operation, sessionId, revision, turnId, phase: loaded ? 'locating' : 'loading' }
    setJumpError(undefined)
    setPendingJump(intent)
    if (loaded) return
    try {
      const page = await readPage(cursor)
      if (operation !== jumpSequence.current) return
      commit(page)
      if (!timelineItems(page.entries, [], []).some((turn) => turn.id === turnId)) throw new Error('未找到目标轮次，请重试。')
      setPendingJump({ ...intent, phase: 'locating' })
    } catch (cause) {
      if (operation !== jumpSequence.current) return
      finishTurnJump(operation, cause instanceof Error ? cause.message : '跳转失败，请重试')
    }
  }, [commit, readPage, revision, sessionId, finishTurnJump])
  const historyQuery = { ...query, hasPreviousPage: Boolean(oldestPage?.hasEarlier), isFetchingPreviousPage: paging === sessionId, fetchPreviousPage: loadEarlier }
  return {
    history, historyQuery, historyError: query.isError || failure?.sessionId === sessionId,
    historyTurnCount: historyUserTurnCount(history?.entries), turnIndexQuery: index,
    navigationNotice: index.isError ? '完整轮次导航暂不可用' : undefined,
    pendingJump: pendingJump?.sessionId === sessionId && pendingJump.revision === revision ? pendingJump : undefined,
    jumpError: jumpError?.sessionId === sessionId && jumpError.revision === revision ? jumpError.message : undefined,
    cancelTurnJump, finishTurnJump, readTurnPrompt, requestTurnJump,
    loadEarlier: () => { void loadEarlier() },
    retryHistory: () => { setFailure(undefined); void query.refetch() },
    retryNavigation: () => { void index.refetch() },
  }
}
