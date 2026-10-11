import type { PiRuntimeEvent } from '@pi-nest/contracts'

export type PromptStatus = 'idle' | 'submitted' | 'awaiting_agent' | 'awaiting_input' | 'running' | 'aborting' | 'aborted' | 'complete' | 'error'
export type PendingInput = { id: string; message: string; mode: 'follow_up' | 'plan_implementation' | 'steer'; submittedAt: string }

export function isRunActive(status: PromptStatus) {
  return status === 'submitted' || status === 'awaiting_agent' || status === 'awaiting_input' || status === 'running' || status === 'aborting'
}

export function nativeUserMessage(event: PiRuntimeEvent) {
  if (event.event.type !== 'message' && event.event.type !== 'message_start') return undefined
  const message = event.event.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  const candidate = message as Record<string, unknown>
  if (candidate.role !== 'user') return undefined
  if (typeof candidate.content === 'string') return candidate.content
  if (!Array.isArray(candidate.content)) return undefined
  const text = candidate.content.flatMap((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return []
    const value = block as Record<string, unknown>
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('')
  return text || undefined
}

export type SessionRunSummary = {
  executionStartedAt?: string
  error?: string
  model?: string
  pendingInputs?: PendingInput[]
  status: PromptStatus
  stopReason?: string
  systemEvents: PiRuntimeEvent[]
  turns: RuntimeTurn[]
  waitingMessage?: string
}

export type RuntimeTurn = {
  completedAt?: string
  events: PiRuntimeEvent[]
  submittedAt?: string
  historyAnchorId?: string
  historyTurnCount?: number
  id: string
  prompt?: string
  startedAt: string
}

