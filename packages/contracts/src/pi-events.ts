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
