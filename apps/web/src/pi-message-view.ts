import type { AttachmentRef, PiRuntimeEvent, PiSessionHistoryEntry } from '@pi-nest/contracts'
import { isPiMessage } from '@pi-nest/contracts/pi-events'

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function messageText(content: unknown, separator = '') {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    const value = record(block)
    return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join(separator)
}

export function historyUserMessage(entry: PiSessionHistoryEntry) {
  return isPiMessage(entry.raw.message, 'user')
}

export function isHistoryUserEntry(entry: PiSessionHistoryEntry) {
  return entry.type === 'message' && historyUserMessage(entry)
}

export function userMessageView(message: Record<string, unknown>) {
  const content = message.content
  const attachments = Array.isArray(content) ? content.flatMap((block) => block?.attachment && typeof block.attachment.id === 'string' ? [block.attachment as AttachmentRef] : []) : []
  return {
    id: typeof message.id === 'string' ? message.id : undefined,
    text: typeof content === 'string' ? content : messageText(content) || undefined,
    attachments,
    warning: typeof message.piNestAttachmentWarning === 'string' ? message.piNestAttachmentWarning : undefined,
  }
}

function copyableAssistantText(message: unknown) {
  if (!isPiMessage(message, 'assistant') || message.stopReason === 'error' || message.stopReason === 'aborted') return undefined
  const text = messageText(message.content, '\n')
  return text.trim() ? text : undefined
}


export function copyableHistoryText(entry: PiSessionHistoryEntry) {
  if (entry.type === 'message') return copyableAssistantText(entry.raw.message)
}

export function copyableRuntimeText({ event }: PiRuntimeEvent) {
  if (event.type === 'message' || event.type === 'message_end') return copyableAssistantText(event.message)
}
