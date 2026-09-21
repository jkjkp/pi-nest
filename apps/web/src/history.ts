import type { PiSessionSummary } from './workspace.js'

export type PiSessionHistoryMessage = {
  hasOmittedContent?: boolean
  id: string
  kind: 'message'
  role: 'assistant' | 'user'
  stopReason?: string
  text: string
  timestamp: string
}

export type PiSessionHistoryOmitted = {
  count: number
  kind: 'omitted'
  label: '未展示的原生事件'
  timestamp: string
}

export type PiSessionHistoryResponse = {
  entries: Array<PiSessionHistoryMessage | PiSessionHistoryOmitted>
  hasEarlier: boolean
  session: PiSessionSummary
}

export function sessionHistoryQueryKey(sessionId: string) {
  return ['session-history', sessionId] as const
}
