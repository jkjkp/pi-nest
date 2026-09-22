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
