import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { fetchSessionHistory, fetchSessionTurnIndex } from './workspace-api.js'
import { mergeSessionHistoryPages, sessionHistoryQueryKey, type PiSessionHistoryResponse } from './history.js'
export type HistoryPages = InfiniteData<PiSessionHistoryResponse, { before?: string; revision?: string }>

/** Replace a snapshot only after the reader's loaded range is available in the new version. */
export async function fetchHistoryView(sessionId: string, signal: AbortSignal, client: QueryClient): Promise<HistoryPages> {
  const latest = await fetchSessionHistory(sessionId, undefined, undefined, signal)
  const pages = [latest]
  const pageParams: HistoryPages['pageParams'] = [{}]
  let index: Awaited<ReturnType<typeof fetchSessionTurnIndex>> | undefined
  const seen = new Set<string>()
  // Recheck after each await: the reader may have loaded more of the old version meanwhile.
  while (pages[0]!.hasEarlier) {
    const previous = mergeSessionHistoryPages(client.getQueryData<HistoryPages>(sessionHistoryQueryKey(sessionId))?.pages)
    const oldest = previous?.entries.find((entry) => entry.type === 'message' && (entry.raw.message as Record<string, unknown> | undefined)?.role === 'user')?.id
    if (!oldest || pages.some((page) => page.entries.some((entry) => entry.id === oldest))) break
    index ??= await fetchSessionTurnIndex(sessionId, latest.revision, signal)
    if (!index.entries.some((entry) => entry.id === oldest)) break
    const before = pages[0]!.beforeCursor
    if (!before || seen.has(before)) throw new Error('历史分页游标无效')
    seen.add(before)
    const page = await fetchSessionHistory(sessionId, before, latest.revision, signal)
    if (page.revision !== latest.revision) throw new Error('历史版本不一致')
    pages.unshift(page)
    pageParams.unshift({ before, revision: latest.revision })
  }
  signal.throwIfAborted()
  return { pages, pageParams }
}
