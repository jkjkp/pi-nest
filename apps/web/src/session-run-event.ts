import { isPiDialogMethod, isPiMessage, piAssistantStopReason, piQueueSnapshot, piRunSettlement, piToolCallId } from '@pi-nest/contracts/pi-events'
import type { PiHistoryChange, PiQueuedInput, PiRuntimeEvent, PiRuntimeExtensionUi, PiRuntimeSessionSnapshot } from '@pi-nest/contracts'
import { messageText, record } from './pi-message-view.js'
import { readExtensionProjection, type ExtensionProjection } from './runtime-extension-event.js'
import { readExtensionUi, readHistoryChange } from './runtime-websocket-client.js'

type SessionRunSignal =
  | { kind: 'queue_snapshot'; queue: NonNullable<PiRuntimeSessionSnapshot['inputQueue']> }
  | { kind: 'input_echo'; message: string }
  | { kind: 'run_started' }
  | { kind: 'execution_activity' }
  | { kind: 'waiting_for_input' }
  | { kind: 'input_resolved' }
  | { kind: 'stop_reason_observed'; reason: string }
  | { kind: 'run_settled'; aborted: boolean }
  | { kind: 'history_replaced'; change?: PiHistoryChange; projection?: PiRuntimeExtensionUi }
  | { kind: 'thinking_level'; level: string }
  | { kind: 'extension_projection'; projection: ExtensionProjection }
  | { kind: 'automatic_compaction_finished' }

export function readSessionRunSignal(event: PiRuntimeEvent): SessionRunSignal | undefined {
  const raw = event.event
  const { type } = raw
  if (type === 'agent_start') return { kind: 'run_started' }
  if (type === 'turn_start' || type === 'message_update' || (typeof type === 'string' && type.startsWith('tool_execution_'))) {
    return { kind: 'execution_activity' }
  }
  if (type === 'message' && (isPiMessage(raw.message, 'assistant') || isPiMessage(raw.message, 'toolResult'))) {
    return { kind: 'execution_activity' }
  }
  if (type === 'extension_ui_request') {
    if (isPiDialogMethod(raw.method)) return { kind: 'waiting_for_input' }
    const projection = readExtensionProjection(event)
    if (projection) return { kind: 'extension_projection', projection }
  }
  if (type === 'history_changed') {
    const change = readHistoryChange(raw.change)
    return change && change.sequence === event.sequence
      ? { kind: 'history_replaced', change, projection: readExtensionUi(raw.extensionUi) }
      : { kind: 'history_replaced' }
  }
  if (type === 'thinking_level_changed' && typeof raw.level === 'string') return { kind: 'thinking_level', level: raw.level }
  if (type === 'auto_compaction_end') return { kind: 'automatic_compaction_finished' }
  if (type === 'extension_ui_resolved') return { kind: 'input_resolved' }

  if (type === 'message_end') {
    const reason = piAssistantStopReason(raw)
    if (reason !== undefined) return { kind: 'stop_reason_observed', reason }
    return
  }
  const settlement = piRunSettlement(raw)
  if (settlement) return { kind: 'run_settled', aborted: settlement.aborted }

  const queue = piQueueSnapshot(raw)
  if (queue) {
    return {
      kind: 'queue_snapshot',
      queue: {
        ...queue,
        ...(Array.isArray(raw.inputs) ? { inputs: raw.inputs as PiQueuedInput[] } : {}),
        ...(Array.isArray(raw.steeringInputs) ? { steeringInputs: raw.steeringInputs as PiQueuedInput[] } : {}),
      },
    }
  }

  const message = runtimeInputEcho(event)
  if (message) return { kind: 'input_echo', message }
}

export function runtimeInputEcho(event: PiRuntimeEvent) {
  if (event.event.type !== 'message' && event.event.type !== 'message_start') return undefined
  const message = event.event.message
  if (!isPiMessage(message, 'user')) return undefined
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return messageText(content) || (content.some((block) => block && typeof block === 'object' && block.type === 'image') ? '图片附件' : undefined)
}

export function runtimeMessageIdentity(event: PiRuntimeEvent) {
  const value = record(event.event.message ?? event.event.partial)
  if (!value) return undefined
  const hasId = typeof value.id === 'string' || typeof value.id === 'number'
  const id = hasId ? value.id : value.timestamp
  return (typeof id === 'string' || typeof id === 'number') ? JSON.stringify([value.role, hasId ? 'id' : 'timestamp', id]) : undefined
}

export function runtimeToolCallId(event: PiRuntimeEvent) {
  return piToolCallId(event.event, event.event.message)
}

export function isStreamingUpdate({ event }: PiRuntimeEvent) {
  return event.type === 'message_update'
}

export function readManualCompaction({ event }: PiRuntimeEvent) {
  if (event.type !== 'compaction_end') return undefined
  if (event.aborted === true) return 'aborted'
  if (event.reason === 'manual' && event.aborted === false && record(event.result) && !event.errorMessage) return 'completed'
}
