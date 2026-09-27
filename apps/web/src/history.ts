import type { PiSessionSummary } from './workspace.js'

export const historyPageSize = 40

export type PiSessionHistoryEntry = {
  id: string
  parentId: string | null
  raw: Record<string, unknown>
  timestamp: string
  type: string
}

export type PiSessionHistoryResponse = {
  beforeCursor?: string
  entries: PiSessionHistoryEntry[]
  hasEarlier: boolean
  revision: string
  session: PiSessionSummary
}

export type TurnIndexEntry = {
  id: string
  index: number
  promptPreview: string
  startedAt: string
}

export type PiSessionTurnIndex = { entries: TurnIndexEntry[]; revision: string }

export function sessionHistoryQueryKey(sessionId: string) {
  return ['session-history', sessionId] as const
}

export function sessionTurnIndexQueryKey(sessionId: string, revision?: string) {
  return revision === undefined ? ['session-turn-index', sessionId] as const : ['session-turn-index', sessionId, revision] as const
}

/** The next Turn-start cursor makes the selected Turn the last item in its page. */
export function historyPageCursorForTurn(entries: TurnIndexEntry[], turnId: string) {
  const index = entries.findIndex((entry) => entry.id === turnId)
  return index < 0 || index === entries.length - 1 ? undefined : entries[index + 1]!.id
}

export function mergeSessionHistoryPages(pages: PiSessionHistoryResponse[] | undefined) {
  const ordered = orderSessionHistoryPages(pages)
  const latest = ordered.at(-1)
  if (!latest) return undefined
  const seen = new Set<string>()
  return { ...latest, entries: ordered.flatMap((page) => page.entries.filter((entry) => !seen.has(entry.id) && Boolean(seen.add(entry.id)))) }
}

/** Keeps arbitrary navigation loads while preserving chronological Turn pages. */
export function mergeSessionHistoryPage(pages: PiSessionHistoryResponse[] | undefined, page: PiSessionHistoryResponse) {
  return orderSessionHistoryPages([...(pages ?? []), page])
}

function orderSessionHistoryPages(pages: PiSessionHistoryResponse[] | undefined) {
  const unique = new Map<string, PiSessionHistoryResponse>()
  for (const page of pages ?? []) {
    const key = page.entries.find((entry) => entry.type === 'message' && (entry.raw.message as Record<string, unknown> | undefined)?.role === 'user')?.id ?? page.entries[0]?.id
    if (key) unique.set(key, page)
  }
  return [...unique.values()].sort((left, right) => (left.entries[0]?.timestamp ?? '').localeCompare(right.entries[0]?.timestamp ?? ''))
}

/** Counts only persisted user entries; runtime events never define conversation structure. */
export function historyUserTurnCount(entries: PiSessionHistoryEntry[] | undefined) {
  return entries?.filter((entry) => {
    const message = entry.raw.message
    return message && typeof message === 'object' && !Array.isArray(message) && (message as Record<string, unknown>).role === 'user'
  }).length
}
