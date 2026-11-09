export function isPiMessage(value: unknown, role: string): value is Record<string, unknown> & { role: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).role === role
}

export function piAssistantStopReason(event: Record<string, unknown>) {
  if (event.type !== 'message_end') return undefined
  const message = event.message
  if (!isPiMessage(message, 'assistant') || typeof message.stopReason !== 'string') return undefined
  return message.stopReason
}

// Callers keep their existing message view: runtime ownership accepts more shapes than display projection.
export function piToolCallId(event: Record<string, unknown>, message: unknown) {
  const id = event.toolCallId ?? (message as { toolCallId?: unknown } | null | undefined)?.toolCallId
  return typeof id === 'string' ? id : undefined
}

export function piRunSettlement(event: Record<string, unknown>) {
  if (event.type === 'agent_settled') return { aborted: event.aborted === true }
}

export function piQueueSnapshot(event: Record<string, unknown>) {
  if (event.type !== 'queue_update') return
  const { steering, followUp } = event
  if (Array.isArray(steering) && steering.every((item) => typeof item === 'string') &&
    Array.isArray(followUp) && followUp.every((item) => typeof item === 'string')) return { steering, followUp }
}

export function isPiDialogMethod(method: unknown): method is 'confirm' | 'editor' | 'input' | 'select' {
  return method === 'select' || method === 'confirm' || method === 'input' || method === 'editor'
}

export function piExtensionDialogId(event: Record<string, unknown>) {
  if (event.type === 'extension_ui_request' && typeof event.id === 'string' && isPiDialogMethod(event.method)) return event.id
}

export type PiExtensionProjection =
  | { kind: 'status'; key: string; text: string | undefined }
  | { kind: 'widget'; key: string; lines: string[] | undefined }

export function piExtensionProjection(event: Record<string, unknown>): PiExtensionProjection | undefined {
  const method = event.type === 'extension_ui_request' ? event.method : event.type
  if (method === 'setStatus' && typeof event.statusKey === 'string' && event.statusKey) {
    return { kind: 'status', key: event.statusKey, text: typeof event.statusText === 'string' ? event.statusText : undefined }
  }
  if (method === 'setWidget' && typeof event.widgetKey === 'string' && event.widgetKey) {
    return { kind: 'widget', key: event.widgetKey, lines: Array.isArray(event.widgetLines) && event.widgetLines.every((line) => typeof line === 'string') ? event.widgetLines : undefined }
  }
}
