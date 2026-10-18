import type { PiRuntimeEvent, AttachmentRef, PiQueuedInput } from '@pi-nest/contracts'

export type PromptStatus = 'idle' | 'submitted' | 'awaiting_agent' | 'awaiting_input' | 'running' | 'aborting' | 'aborted' | 'complete' | 'error'
export type PendingInput = { id: string; message: string; mode: 'follow_up' | 'plan_implementation' | 'steer'; submittedAt: string; submitting?: boolean; attachments?: AttachmentRef[]; submissionId?: string; recoveryRequired?: boolean }

export function reconcilePendingInputs(pending: PendingInput[], queue: { steering: string[]; followUp: string[]; inputs?: PiQueuedInput[]; steeringInputs?: PiQueuedInput[] }, key: string): PendingInput[] {
  if (queue.steeringInputs) {
    const steering = queue.steeringInputs.map((input) => ({ ...input, mode: 'steer' as const, submittedAt: pending.find((saved) => saved.id === input.id)?.submittedAt ?? new Date().toISOString(), submitting: false }))
    return [...steering, ...reconcilePendingInputs(pending.filter((input) => input.mode !== 'steer'), { followUp: queue.followUp, steering: [], inputs: queue.inputs }, key)]
  }
  if (queue.inputs) {
    const known = queue.inputs.map((input) => ({ ...input, mode: 'follow_up' as const, submittedAt: pending.find((p) => p.id === input.id)?.submittedAt ?? new Date().toISOString(), submitting: false }))
    const unknownCount = queue.followUp.length - known.length
    return [...reconcilePendingInputs(pending.filter((p) => !p.attachments?.length), { steering: queue.steering, followUp: queue.followUp.slice(0, Math.max(0, unknownCount)) }, key), ...known]
  }
  const remaining = [...pending]
  const inputs = (['steer', 'follow_up'] as const).flatMap((mode) => (mode === 'steer' ? queue.steering : queue.followUp).map((message, index) => {
    const match = remaining.findIndex((input) => input.mode === mode && input.message === message)
    const saved = match < 0 ? undefined : remaining.splice(match, 1)[0]
    return saved ? { ...saved, submitting: false } : { id: `queue:${key}:${mode}:${index}`, message, mode, submittedAt: new Date().toISOString() }
  }))
  return [...inputs, ...remaining.filter((input) => input.mode === 'plan_implementation')]
}

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
  return text || (candidate.content.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'image') ? '图片附件' : undefined)
}

export type SessionRunSummary = {
  attachmentWarning?: string
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
  attachments?: AttachmentRef[]
  submissionId?: string
  runId?: string
  steering?: { status: 'sending' | 'accepted' | 'applied' | 'failed' | 'unknown'; error?: string; queuedInputId?: string }
  executionStartedAt?: string
  completedAt?: string
  events: PiRuntimeEvent[]
  submittedAt?: string
  historyAnchorId?: string
  historyTurnCount?: number
  id: string
  prompt?: string
  startedAt: string
}

export function activeRuntimeTurn(turns: RuntimeTurn[]) {
  return turns.findLast((turn) => !turn.steering || turn.steering.status === 'applied')
}

export function runtimeMessageIdentity(event: PiRuntimeEvent) {
  const message = event.event.message ?? event.event.partial
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  const value = message as Record<string, unknown>
  const id = value.id ?? value.timestamp
  return (typeof id === 'string' || typeof id === 'number') ? `${value.role}:${id}` : undefined
}


export function messageAttachments(message: unknown): AttachmentRef[] {
  if (!message || typeof message !== 'object') return []
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => block?.attachment && typeof block.attachment.id === 'string' ? [block.attachment as AttachmentRef] : [])
}
