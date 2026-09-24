import type { PiSessionSummary } from './workspace.js'

export type PiSessionHistoryEntry = {
  id: string
  parentId: string | null
  raw: Record<string, unknown>
  timestamp: string
  type: string
}

export type PiSessionHistoryResponse = {
  entries: PiSessionHistoryEntry[]
  hasEarlier: boolean
  session: PiSessionSummary
}

export function sessionHistoryQueryKey(sessionId: string) {
  return ['session-history', sessionId] as const
}

/** Counts only persisted user entries; runtime events never define conversation structure. */
export function historyUserTurnCount(entries: PiSessionHistoryEntry[] | undefined) {
  return entries?.filter((entry) => {
    const message = entry.raw.message
    return message && typeof message === 'object' && !Array.isArray(message) && (message as Record<string, unknown>).role === 'user'
  }).length
}
