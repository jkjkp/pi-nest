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
  session: PiSessionSummary
}

export type TurnIndexEntry = {
  id: string
  index: number
  promptPreview: string
  startedAt: string
}

export function sessionHistoryQueryKey(sessionId: string) {
  return ['session-history', sessionId] as const
}

export function sessionTurnIndexQueryKey(sessionId: string) {
  return ['session-turn-index', sessionId] as const
}

/** The next Turn-start cursor makes the selected Turn the last item in its page. */
export function historyPageCursorForTurn(entries: TurnIndexEntry[], turnId: string) {
  const index = entries.findIndex((entry) => entry.id === turnId)
  return index < 0 || index === entries.length - 1 ? undefined : entries[index + 1]!.id
}

export function mergeSessionHistoryPages(pages: PiSessionHistoryResponse[] | undefined) {
  const latest = pages?.at(-1)
  return latest ? { ...latest, entries: pages!.flatMap((page) => page.entries) } : undefined
}

/** Counts only persisted user entries; runtime events never define conversation structure. */
export function historyUserTurnCount(entries: PiSessionHistoryEntry[] | undefined) {
  return entries?.filter((entry) => {
    const message = entry.raw.message
    return message && typeof message === 'object' && !Array.isArray(message) && (message as Record<string, unknown>).role === 'user'
  }).length
}
