import type { AttachmentInput, AttachmentRef, PiQueuedInput, PiRuntimeSessionSnapshot } from '@pi-nest/contracts'
import { randomUUID } from 'node:crypto'
import { capturePiSessionHistory } from '@pi-nest/pi-adapter'
import { AttachmentError, type AttachmentStore, type PreparedInput } from './attachment-store.js'
import type { PiRuntimeHost, PiRuntimeSession } from './pi-runtime-host.js'

export type QueuedInputView = Readonly<Omit<PiQueuedInput, 'attachmentIds' | 'attachments'>> & {
  readonly attachmentIds?: readonly string[]
  readonly attachments?: readonly Readonly<AttachmentRef>[]
}

/** Queue records and receipts only; Registry owns reservations, host admission and advancement. */
export class SessionInputQueue {
  private inputQueue?: PiRuntimeSessionSnapshot['inputQueue']
  private queuedFollowUps?: PiQueuedInput[]

  constructor(private readonly sessionId: string, private readonly attachments: AttachmentStore) {
    const restored = [...this.attachments.queue(sessionId), ...this.attachments.steering(sessionId)]
    const unique = [...new Map(restored.map((input) => [input.id, input])).values()]
    this.queuedFollowUps = unique.map((input) => ({ ...input, recoveryRequired: true }))
  }

  selectForSteering(command: Record<string, unknown>): QueuedInputView {
    const index = typeof command.inputId === 'string' ? this.queuedFollowUps?.findIndex((input) => input.id === command.inputId) ?? -1 : Number(command.index) - (this.inputQueue?.followUp.length ?? 0)
    const queue = this.queuedFollowUps
    if (!queue || index < 0 || queue[index]?.message !== command.message) throw new Error('Queued message has already changed')
    return queue[index]!
  }

  selectForRecovery(inputId: string): QueuedInputView {
    const input = this.queuedFollowUps?.find((input) => input.id === inputId)
    if (!input || !input.recoveryRequired) throw new AttachmentError('待确认消息已变化。', 409)
    return input
  }

  selectForDrop(inputId: string): QueuedInputView {
    const input = this.queuedFollowUps?.find((input) => input.id === inputId)
    if (!input) throw new AttachmentError('排队消息已变化，请刷新后重试。', 409)
    return input
  }

  nextForDelivery(): QueuedInputView | undefined {
    const input = this.queuedFollowUps?.[0]
    return input?.recoveryRequired ? undefined : input
  }

  // Keep record identity across awaits; the same ID can refer to a replaced record.
  contains(input: QueuedInputView) { return this.queuedFollowUps?.some((queued) => queued === input) ?? false }

  isHead(input: QueuedInputView) { return this.queuedFollowUps?.[0] === input }

  async enqueue(command: Record<string, unknown>, sessionFile: string, publish: () => Promise<unknown>) {
    if (typeof command.message !== 'string') throw new Error('Invalid follow-up')
    const sessionId = this.sessionId
    this.queuedFollowUps ??= []
    const input: PiQueuedInput = { id: typeof command.submissionId === 'string' ? command.submissionId : randomUUID(), message: command.message, ...(Array.isArray(command.attachmentIds) ? { attachmentIds: command.attachmentIds as string[], submissionId: command.submissionId as string } : {}) }
    await this.attachments.prepare(sessionId, input)
    if (input.attachmentIds?.length) input.attachments = this.attachments.refs(input.attachmentIds, sessionId)
    return this.attachments.deliver(sessionId, input, async () => {
      if (!this.queuedFollowUps!.some((queued) => queued.id === input.id)) this.queuedFollowUps!.push(input)
      try { this.save(); await publish() }
      catch (cause) { this.remove(input.id); throw cause }
      return { success: true }
    }, sessionFile, 'follow_up')
  }

  prepare(input: AttachmentInput | QueuedInputView) {
    return this.attachments.prepare(this.sessionId, { ...input, attachmentIds: input.attachmentIds?.slice() })
  }

  async steer(input: AttachmentInput, host: Pick<PiRuntimeHost, 'command'>, sessionFile: string) {
    const prepared = await this.prepare(input)
    return this.attachments.deliver(this.sessionId, input, () => this.sendAttachmentSteering(input, host, prepared), sessionFile, 'steer')
  }

  async sendAttachmentSteering(input: AttachmentInput | QueuedInputView, host: Pick<PiRuntimeHost, 'command'>, prepared: PreparedInput) {
    const sessionId = this.sessionId
    const payload = prepared
    const attachmentIds = input.attachmentIds?.slice()
    const pending: PiQueuedInput = { ...input, attachmentIds, id: input.submissionId!, attachments: this.attachments.refs(attachmentIds ?? [], sessionId) }
    const saved = this.attachments.steering(sessionId)
    if (!saved.some((item) => item.id === pending.id)) this.attachments.steering(sessionId, [...saved, pending])
    try {
      const response = await host.command({ type: 'steer', ...payload })
      if ((response.data as { disposition?: string } | undefined)?.disposition === 'handled') this.attachments.steering(sessionId, this.attachments.steering(sessionId).filter((item) => item.id !== pending.id))
      return response
    }
    catch (cause) {
      if (!(cause instanceof Error && /connection|timed out|exited/i.test(cause.message))) this.attachments.steering(sessionId, this.attachments.steering(sessionId).filter((item) => item.id !== pending.id))
      else {
        const queued = this.queuedFollowUps?.find((item) => item.id === pending.id)
        if (queued) { queued.recoveryRequired = true; this.save() }
      }
      throw cause
    }
  }

  setNativeQueue(steering: string[], followUp: string[]) {
    this.inputQueue = { steering: [...steering], followUp: [...followUp] }
  }

  recoverAfterFailure() {
    const pending = [...(this.queuedFollowUps ?? []), ...this.attachments.steering(this.sessionId)]
    this.queuedFollowUps = [...new Map(pending.map((input) => [input.id, { ...input, recoveryRequired: true }])).values()]
    if (!this.queuedFollowUps.length) return false
    this.save()
    return true
  }

  acknowledge(input: QueuedInputView) {
    this.remove(input.id)
    this.save()
  }

  retire(input: QueuedInputView) {
    const removed = this.remove(input.id)
    this.removeSteering(input.id)
    this.save()
    return removed
  }

  private save() { this.attachments.queue(this.sessionId, this.queuedFollowUps ?? []) }

  private removeSteering(inputId: string) {
    this.attachments.steering(this.sessionId, this.attachments.steering(this.sessionId).filter((item) => item.id !== inputId))
  }

  isRecorded(session: PiRuntimeSession, input: QueuedInputView) {
    return input.submissionId && capturePiSessionHistory({ sessionFile: session.sessionFile, expectedSessionId: session.id, expectedCwd: session.cwd }).entries.some((entry) => {
      if (entry.type !== 'message' || entry.message.role !== 'user') return false
      const content = entry.message.content
      const text = typeof content === 'string' ? content : content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
      return text.includes(`<pi-nest-attachments id="${input.submissionId}">`)
    })
  }

  snapshot() {
    const sessionId = this.sessionId
    const nativeSteering = this.inputQueue?.steering ?? []
    const pendingSteering = this.attachments.steering(sessionId)
    return {
      steering: nativeSteering.map((text) => this.attachments.displayPrompt(text, sessionId) ?? text),
      followUp: [...(this.inputQueue?.followUp ?? []).map((text) => this.attachments.displayPrompt(text, sessionId) ?? text), ...(this.queuedFollowUps ?? []).map((input) => input.message)],
      ...((this.queuedFollowUps ?? []).some((input) => input.attachmentIds?.length || input.recoveryRequired) ? { inputs: this.queuedFollowUps?.map((input) => ({ ...input })) } : {}),
      ...(pendingSteering.length && nativeSteering.length ? { steeringInputs: nativeSteering.map((text, index) => {
        const saved = pendingSteering.find((input) => input.submissionId && text.includes(input.submissionId))
        return saved ? { ...saved } : { id: `native-steer:${index}`, message: this.attachments.displayPrompt(text, sessionId) ?? text }
      }) } : {}),
    }
  }

  private remove(inputId: string) {
    const queue = this.queuedFollowUps
    const index = queue?.findIndex((input) => input.id === inputId) ?? -1
    if (index >= 0) return queue!.splice(index, 1)[0]
  }

  reject(input: QueuedInputView, cause: unknown) {
    const index = this.queuedFollowUps?.findIndex((queued) => queued === input) ?? -1
    if (index < 0) return false
    this.queuedFollowUps![index] = { ...this.queuedFollowUps![index]!, error: cause instanceof Error && cause.message ? cause.message : '附件不可用，请重新上传。', recoveryRequired: true }
    this.save()
    return true
  }
}
