import { isPiMessage, piAssistantStopReason, piQueueSnapshot, piRunSettlement } from '@pi-nest/contracts/pi-events'

export function readNativeRunEvent(event: Record<string, unknown>) {
  if (event.type === 'agent_start') return { kind: 'started' as const }
  if (event.type === 'message') {
    if (isPiMessage(event.message, 'user')) return { kind: 'user_input' as const }
    if (isPiMessage(event.message, 'assistant')) return { kind: 'streaming' as const }
  }
  if (event.type === 'message_update') return { kind: 'streaming' as const }
  const stopReason = piAssistantStopReason(event)
  if (stopReason !== undefined) return { kind: 'stop_reason' as const, reason: stopReason }
  const settlement = piRunSettlement(event)
  if (settlement) return { kind: 'settled' as const, aborted: settlement.aborted }
  if (event.type === 'queue_update') return { kind: 'queue' as const, snapshot: piQueueSnapshot(event) }
}

export function readNativeTurnBoundary(event: Record<string, unknown>) {
  if (event.type === 'turn_start') return 'start'
  if (event.type === 'turn_end' || piRunSettlement(event)) return 'end'
}
