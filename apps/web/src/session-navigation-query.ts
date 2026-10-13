import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { sessionHistoryQueryKey, sessionTurnIndexQueryKey, type PiSessionHistoryResponse } from './history.js'
import { fetchSessionHistory, fetchSessionTurnIndex, RequestError } from './workspace-api.js'

/** A conflict gets one fresh snapshot and index attempt, never a retry loop. */
export async function fetchSessionNavigation(sessionId: string, revision: string, signal: AbortSignal, queryClient: QueryClient) {
  try {
    return await fetchSessionTurnIndex(sessionId, revision, signal)
  } catch (cause) {
    if (!(cause instanceof RequestError) || cause.status !== 409 || cause.code !== 'REVISION_CHANGED') throw cause
  }
  const history = await fetchSessionHistory(sessionId, undefined, undefined, signal)
  const index = await fetchSessionTurnIndex(sessionId, history.revision, signal)
  signal.throwIfAborted()
  await queryClient.cancelQueries({ queryKey: sessionHistoryQueryKey(sessionId) })
  signal.throwIfAborted()
  queryClient.removeQueries({ queryKey: ['session-history-page', sessionId] })
  queryClient.setQueryData(sessionTurnIndexQueryKey(sessionId, history.revision), index)
  queryClient.setQueryData<InfiniteData<PiSessionHistoryResponse>>(sessionHistoryQueryKey(sessionId), { pages: [history], pageParams: [{}] })
  return index
}
