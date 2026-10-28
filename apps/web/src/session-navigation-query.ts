import { fetchHistoryView, readCachedTurnIndex } from './history-view.js'
import type { QueryClient } from '@tanstack/react-query'
import { sessionHistoryQueryKey, sessionTurnIndexQueryKey } from './history.js'
import { fetchSessionTurnIndex, RequestError } from './workspace-api.js'

/** A conflict gets one fresh snapshot and index attempt, never a retry loop. */
export async function fetchSessionNavigation(sessionId: string, revision: string, signal: AbortSignal, queryClient: QueryClient) {
  try {
    return await fetchSessionTurnIndex(sessionId, revision, signal)
  } catch (cause) {
    if (!(cause instanceof RequestError) || cause.status !== 409 || !['REVISION_CHANGED', 'HISTORY_SNAPSHOT_EXPIRED'].includes(cause.code ?? '')) throw cause
  }
  const view = await fetchHistoryView(sessionId, signal, queryClient)
  const history = view.pages.at(-1)!
  const index = await readCachedTurnIndex(sessionId, history.revision, signal, queryClient)
  signal.throwIfAborted()
  await queryClient.cancelQueries({ queryKey: sessionHistoryQueryKey(sessionId) })
  signal.throwIfAborted()
  queryClient.removeQueries({ queryKey: ['session-history-page', sessionId] })
  queryClient.setQueryData(sessionTurnIndexQueryKey(sessionId, history.revision), index)
  queryClient.setQueryData(sessionHistoryQueryKey(sessionId), view)
  return index
}
