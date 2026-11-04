import { isPiMessage, piAssistantStopReason } from '@pi-nest/contracts/pi-events'
import { AttachmentStore, AttachmentError, type PreparedInput } from './attachment-store.js'
import type { AttachmentInput, PiEditLastInput, PiEditStatus, PiHistoryChange, PiPromptDisposition, PiQueuedInput, PiSessionInitialSettings } from '@pi-nest/contracts'
import type { RuntimeLifecycle as PiRuntimeLifecycle, RuntimeStatus as PiRuntimeStatus, PiRuntimeExtensionUi, PiRuntimeSessionSnapshot } from '@pi-nest/contracts'
export type { RuntimeLifecycle as PiRuntimeLifecycle, RuntimeStatus as PiRuntimeStatus, PiRuntimeExtensionUi, PiRuntimeSessionSnapshot } from '@pi-nest/contracts'

import { PiRpcCommandError, editRecord, entryPath, piEditBoundary, piEditStatus, readPiEditEntries } from '@pi-nest/pi-adapter'
import { existsSync, readFileSync } from 'node:fs'

import { SessionHistorySnapshots } from './session-history-snapshots.js'
import { SessionInputQueue, type QueuedInputView } from './session-input-queue.js'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiRuntimeHost, PiRuntimeHostError, promptDisposition, type PiRuntimeEvent, type PiRuntimeFailureKind, type PiRuntimeHostEvent, type PiRuntimeHostFailure, type PiRuntimePromptResult, type PiRuntimeSession } from './pi-runtime-host.js'
import { ProjectionSidecarStore } from './projection-sidecar-store.js'
import { RuntimeExtensionState } from './runtime-extension-state.js'
import { PiRuntimeResumeError, type PiRuntimeStreamError, SessionEventStream } from './session-event-stream.js'

type HostFactory = (session: PiRuntimeSession) => PiRuntimeHost
type Lock = 'mutation' | 'prompt' | 'read' | 'resume'
type IdleOperation = { promise: Promise<unknown>; lock?: Exclude<Lock, 'prompt'> }
type RegistryEntry = { failureUnsubscribe: () => void; host: PiRuntimeHost; lastUsed: number; session: PiRuntimeSession; unsubscribe: () => void }
type StreamEntry = { stream: SessionEventStream }
type StreamListener = (event: PiRuntimeEvent) => void
type StreamErrorListener = (error: PiRuntimeStreamError) => void
type UnloadReason = 'capacityEvicted' | 'deleted' | 'failed' | 'idleExpired' | 'mutation' | 'settingsReload' | 'shutdown'
type ActiveTurn = { editPreparing?: boolean; cancelEdit?: true; agentStarted?: true; firstSequence?: number; native?: true; prompt?: string; runId: string; startedAt: string; stopReason?: string; waitingForExtension?: true }
type RuntimeState = {
  historyChange?: PiHistoryChange
  queue: SessionInputQueue
  promotingInput?: boolean
  activeTurn?: ActiveTurn
  completedRun?: { runId: string; stopReason: string }
  error?: string
  failureKind?: PiRuntimeFailureKind
  lifecycle: PiRuntimeLifecycle
  listeners: Set<RuntimeStatusListener>
  revision: number
  subscribers: Map<string, () => void>
  unloadGeneration: number
  unloadTimer: NodeJS.Timeout | undefined
}

export type PiRuntimePrompt = { accepted: Promise<PiPromptDisposition>; runId: string; settled: Promise<PiRuntimePromptResult> }
type RuntimeStatusListener = (status: PiRuntimeStatus) => void

export class PiSessionDeletionError extends Error {
  constructor(readonly code: string, readonly status: 404 | 409 | 503, message: string) { super(message) }
}

export class PiRuntimeBusyError extends Error {
  constructor() { super('Pi session is busy') }
}
export class PiSessionEditError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class PiRuntimeCapacityError extends Error {
  constructor() { super('Pi runtime capacity is exhausted') }
}

function configuredPositiveInteger(name: string, fallback: number) {
  const value = process.env[name]
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`)
  return Number(value)
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

export type PiRuntimeRegistryOptions = {
  attachmentDirectory?: string
  createHost?: HostFactory
  eventBufferDirectory?: string
  maxLoadedRuntimes?: number
  projectionDirectory?: string
  runtimeStartTimeoutMs?: number
  runtimeUnloadGraceMs?: number
}

/** Single-process ownership and lifecycle manager for native Pi sessions. */
export class PiRuntimeRegistry {
  readonly history = new SessionHistorySnapshots()
  readonly attachments: AttachmentStore
  private readonly createHost: HostFactory
  private admission = Promise.resolve()
  private readonly entries = new Map<string, RegistryEntry>()
  private readonly eventBufferDirectory: Promise<string>
  private readonly expiredStreams = new Set<string>()
  private readonly compacting = new Set<string>()
  private readonly extensionCommands = new Set<string>()
  private readonly locks = new Map<string, Lock>()
  private readonly idleOperations = new Map<string, Set<IdleOperation>>()
  private readonly extensionResponses = new Set<string>()
  private readonly deleting = new Set<string>()
  private readonly deleted = new Set<string>()
  private readonly extensionState: RuntimeExtensionState
  private readonly projectionsReady: Promise<void>
  private readonly states = new Map<string, RuntimeState>()
  private settingsUpdating = false
  private readonly streams = new Map<string, StreamEntry>()
  private usageClock = 0

  constructor(options: PiRuntimeRegistryOptions = {}) {
    this.attachments = new AttachmentStore(options.attachmentDirectory ?? (process.env.VITEST ? join(tmpdir(), `pi-nest-test-attachments-${randomUUID()}`) : undefined))
    this.runtimeStartTimeoutMs = positiveInteger(options.runtimeStartTimeoutMs ?? configuredPositiveInteger('PI_NEST_RUNTIME_START_TIMEOUT_MS', 30_000), 'PI_NEST_RUNTIME_START_TIMEOUT_MS')
    this.maxLoadedRuntimes = positiveInteger(options.maxLoadedRuntimes ?? configuredPositiveInteger('PI_NEST_MAX_LOADED_RUNTIMES', 4), 'PI_NEST_MAX_LOADED_RUNTIMES')
    this.createHost = options.createHost ?? ((session) => new PiRuntimeHost(session, undefined, this.runtimeStartTimeoutMs))
    this.runtimeUnloadGraceMs = positiveInteger(options.runtimeUnloadGraceMs ?? configuredPositiveInteger('PI_NEST_RUNTIME_UNLOAD_GRACE_MS', 30 * 60_000), 'PI_NEST_RUNTIME_UNLOAD_GRACE_MS')
    this.eventBufferDirectory = this.createBufferDirectory(options.eventBufferDirectory)
    this.extensionState = new RuntimeExtensionState(new ProjectionSidecarStore({ directory: options.projectionDirectory }))
    this.projectionsReady = this.extensionState.ready
  }

  private readonly runtimeUnloadGraceMs: number
  private readonly runtimeStartTimeoutMs: number
  private readonly maxLoadedRuntimes: number

  sessionAccessError(sessionId: string) {
    if (this.deleted.has(sessionId)) return new PiSessionDeletionError('SESSION_NOT_FOUND', 404, 'Pi 会话已删除。')
    if (this.deleting.has(sessionId)) return new PiSessionDeletionError('SESSION_DELETING', 409, 'Pi 会话正在删除，请稍候。')
    return undefined
  }

  private trackIdleOperation<T>(sessionId: string, operation: Promise<T>, lock?: Exclude<Lock, 'prompt'>) {
    const operations = this.idleOperations.get(sessionId) ?? new Set<IdleOperation>()
    const tracked = operation.finally(() => {
      operations.delete(record)
      if (!operations.size) this.idleOperations.delete(sessionId)
    })
    const record = { promise: tracked, lock }
    operations.add(record)
    this.idleOperations.set(sessionId, operations)
    return tracked
  }

  getSessionStatistics(sessionId: string) {
    const error = this.sessionAccessError(sessionId)
    if (error) throw error
    const operation = this.entries.get(sessionId)?.host.command({ type: 'get_session_stats' })
    return operation ? this.trackIdleOperation(sessionId, operation) : undefined
  }

  isPromptActive(sessionId: string) {
    return this.locks.get(sessionId) === 'prompt'
  }

  isPromptStreaming(sessionId: string) {
    return this.isPromptActive(sessionId) && !this.states.get(sessionId)?.activeTurn?.waitingForExtension
  }

  isAnyPromptActive() {
    return [...this.locks.values()].some((lock) => lock === 'prompt')
  }

  /** Runs an RPC command that is valid only while the agent is actively streaming. */
  async commandWhileRunning(sessionId: string, command: Record<string, unknown>) {
    if (this.sessionAccessError(sessionId) || !this.isPromptActive(sessionId)) return undefined
    const entry = this.entries.get(sessionId)
    if (!entry) return undefined
    if (command.type === 'follow_up') return this.stateFor(sessionId).queue.enqueue(command, entry.session.sessionFile, () => this.publishInputQueue(sessionId))
    if (command.type === 'steer_queued') {
      const state = this.stateFor(sessionId)
      if (state.promotingInput) throw new Error('Queued message has already changed')
      const input = state.queue.selectForSteering(command)
      state.promotingInput = true
      try {
        let prepared: PreparedInput
        try { prepared = await state.queue.prepare(input) }
        catch (cause) { this.rejectQueued(sessionId, input, cause); throw cause }
        if (!state.queue.contains(input)) throw new AttachmentError('排队消息已变化，请刷新后重试。', 409)
        const response = input.attachmentIds?.length ? await state.queue.sendAttachmentSteering(input, entry.host, prepared) : await entry.host.command({ type: 'steer', ...prepared })
        this.stateFor(sessionId).queue.acknowledge(input)
        await this.publishInputQueue(sessionId)
        return response
      } finally {
        state.promotingInput = false
        void this.drainFollowUp(sessionId)
      }
    }
    if (command.type === 'steer' && Array.isArray(command.attachmentIds)) {
      const input = command as AttachmentInput
      return this.stateFor(sessionId).queue.steer(input, entry.host, entry.session.sessionFile)
    }
    const result = entry.host.command(command)
    return command.type === 'get_commands' ? this.trackIdleOperation(sessionId, result) : result
  }

  /** Registered extensions run through Pi's prompt preflight, without inventing a model turn. */
  async executeExtensionCommand(session: PiRuntimeSession, message: string) {
    if (this.sessionAccessError(session.id) || this.settingsUpdating || this.extensionCommands.has(session.id) || this.locks.has(session.id) && !this.isPromptActive(session.id)) throw new PiRuntimeBusyError()
    const entry = this.entries.get(session.id)
    if (!entry) throw new Error('Pi runtime is not loaded')
    this.extensionCommands.add(session.id)
    this.cancelUnload(session.id)
    const ownsLock = !this.locks.has(session.id)
    if (ownsLock) this.locks.set(session.id, 'mutation')
    try {
      const response = await entry.host.command({ type: 'get_commands' })
      const commands = (response.data as { commands?: { name: string; source: string }[] } | undefined)?.commands
      const name = message.trim().match(/^\/([^\s/]+)(?:\s|$)/)?.[1]
      if (!name || !Array.isArray(commands) || !commands.some((command) => command.name === name && command.source === 'extension')) throw new Error('未注册的插件命令，请刷新命令列表后重试。')
      const result = await entry.host.command({ type: 'prompt', message })
      this.touch(session.id)
      return { disposition: promptDisposition(result) }
    } finally {
      this.extensionCommands.delete(session.id)
      if (ownsLock && this.locks.get(session.id) === 'mutation') this.locks.delete(session.id)
      this.scheduleUnload(session.id)
      void this.drainFollowUp(session.id)
    }
  }

  /** Serializes an idle-only RPC control command with other session mutations. */
  commandWhenIdle(session: PiRuntimeSession, command: Record<string, unknown>): Promise<Record<string, unknown> | undefined> | undefined {
    if (this.sessionAccessError(session.id) || this.settingsUpdating || this.locks.has(session.id) || this.extensionCommands.has(session.id)) throw new PiRuntimeBusyError()
    if (!this.entries.has(session.id)) return undefined
    const readOnly = typeof command.type === 'string' && ['get_state', 'get_runtime_state', 'get_available_models', 'get_available_thinking_levels', 'get_commands'].includes(command.type)
    const previousModel = this.entries.get(session.id)?.host.currentModel
    const previousThinking = this.entries.get(session.id)?.host.currentThinkingLevel
    this.cancelUnload(session.id)
    const lock = readOnly ? 'read' : 'mutation'
    this.locks.set(session.id, lock)
    if (!readOnly) this.transition(session.id, 'loading')
    const operation = this.projectionsReady.then(() => this.getOrCreate(session))
      .then((entry) => {
        if (command.type === 'compact') this.compacting.add(session.id)
        return entry.host.command(command)
      })
      .then((result) => {
        const host = this.entries.get(session.id)?.host
        const metadataChanged = host?.currentModel?.id !== previousModel?.id || host?.currentModel?.provider !== previousModel?.provider || host?.currentThinkingLevel !== previousThinking
        this.transition(session.id, this.states.get(session.id)?.activeTurn ? 'active' : 'idle', undefined, undefined, readOnly && metadataChanged)
        this.touch(session.id)
        return result
      })
      .catch(async (cause) => {
        if (cause instanceof PiRuntimeCapacityError) throw cause
        if (cause instanceof PiRpcCommandError) {
          this.transition(session.id, this.states.get(session.id)?.activeTurn ? 'active' : 'idle')
          throw cause
        }
        this.fail(session.id, cause)
        await this.remove(session.id, 'failed')
        throw cause
      })
      .finally(() => {
        this.compacting.delete(session.id)
        if (this.locks.get(session.id) === lock) this.locks.delete(session.id)
        this.scheduleUnload(session.id)
      })
    return this.trackIdleOperation(session.id, operation, lock)
  }

  async respondToExtension(sessionId: string, response: Record<string, unknown>) {
    const error = this.sessionAccessError(sessionId)
    if (error) throw error
    if (this.extensionResponses.has(sessionId)) throw new PiRuntimeBusyError()
    const id = typeof response.id === 'string' ? response.id : undefined
    const pending = id ? this.extensionState.takeDialog(sessionId, id) : undefined
    if (!id || !pending) return false
    const entry = this.entries.get(sessionId)
    if (!entry) {
      pending.restore()
      return false
    }
    this.extensionResponses.add(sessionId)
    try {
      try { await entry.host.respondToExtension(response) }
      catch (cause) { pending.restore(); throw cause }
      await this.publishExtensionDialogResolved(sessionId, id)
      return true
    } finally { this.extensionResponses.delete(sessionId) }
  }

  /** Prevents a global Settings write from racing any runtime start or active run. */
  beginGlobalSettingsUpdate() {
    if (this.settingsUpdating || this.deleting.size > 0 || this.extensionResponses.size > 0 || this.locks.size > 0 || this.extensionCommands.size > 0) return undefined
    this.settingsUpdating = true
    return async (reload = false) => {
      try {
        if (reload) await Promise.all([...this.entries.keys()].map((sessionId) => this.remove(sessionId, 'settingsReload')))
      } finally {
        this.settingsUpdating = false
      }
    }
  }

  async watch(
    sessionId: string,
    subscriberId: string,
    after: number,
    listener: StreamListener,
    onError: StreamErrorListener,
    onSnapshot?: (snapshot: PiRuntimeSessionSnapshot) => void,
    onStatus?: RuntimeStatusListener,
    replayIdle = false,
  ) {
    await this.projectionsReady
    const error = this.sessionAccessError(sessionId)
    if (error) throw error
    const state = this.stateFor(sessionId)
    this.cancelUnload(sessionId)
    const firstSequence = state.activeTurn?.firstSequence
    const replayAfter = firstSequence === undefined ? (replayIdle ? after : undefined) : Math.max(after, firstSequence - 1)
    const entry = this.streamForSubscribe(sessionId, replayAfter)
    const subscribeAfter = replayAfter ?? entry.stream.latestSequence
    let unsubscribeStatus: (() => void) | undefined
    const unsubscribe = await entry.stream.subscribeWithSnapshot(
      subscribeAfter,
      (atSequence) => this.snapshot(sessionId, atSequence, replayAfter),
      (snapshot) => {
        onSnapshot?.(snapshot)
        if (onStatus) {
          state.listeners.add(onStatus)
          unsubscribeStatus = () => state.listeners.delete(onStatus)
        }
      },
      listener,
      onError,
    )
    const accessError = this.sessionAccessError(sessionId)
    if (accessError) { unsubscribe(); unsubscribeStatus?.(); throw accessError }
    const unwatch = () => {
      unsubscribe()
      unsubscribeStatus?.()
      if (state.subscribers.get(subscriberId) !== unwatch) return
      state.subscribers.delete(subscriberId)
      this.scheduleUnload(sessionId)
    }
    const previous = state.subscribers.get(subscriberId)
    previous?.()
    state.subscribers.set(subscriberId, unwatch)
    this.touch(sessionId)
    return unwatch
  }

  unwatch(sessionId: string, subscriberId: string) {
    const unsubscribe = this.states.get(sessionId)?.subscribers.get(subscriberId)
    if (!unsubscribe) return false
    unsubscribe()
    return true
  }

  /** Compatibility helper for direct Registry tests; production callers use watch/unwatch. */
  async subscribe(sessionId: string, after: number, listener: StreamListener, onError: StreamErrorListener, onSnapshot?: (snapshot: PiRuntimeSessionSnapshot) => void, onStatus?: RuntimeStatusListener) {
    return this.watch(sessionId, `legacy:${Math.random()}`, after, listener, onError, onSnapshot, onStatus, true)
  }

  resume(session: PiRuntimeSession): Promise<void> | undefined {
    if (this.sessionAccessError(session.id) || this.settingsUpdating || this.locks.has(session.id) || this.extensionCommands.has(session.id)) return undefined
    const alreadyIdle = this.entries.has(session.id) && this.stateFor(session.id).lifecycle === 'idle'
    this.cancelUnload(session.id)
    this.locks.set(session.id, 'resume')
    return this.trackIdleOperation(session.id, this.projectionsReady.then(() => this.getOrCreate(session))
      .then(async (entry) => {
        this.expiredStreams.delete(session.id)
        this.streamFor(session.id)
        if (!alreadyIdle) this.transition(session.id, 'loading')
        return entry.host.start()
      })
      .then(async () => { await this.publishHistoryChange(session); this.transition(session.id, this.states.get(session.id)?.activeTurn ? 'active' : 'idle'); this.touch(session.id) })
      .catch(async (cause) => {
        if (cause instanceof PiRuntimeCapacityError) throw cause
        this.fail(session.id, cause)
        await this.remove(session.id, 'failed')
        throw cause
      })
      .finally(() => {
        if (this.locks.get(session.id) === 'resume') this.locks.delete(session.id)
        this.scheduleUnload(session.id)
      }), 'resume')
  }

  startPrompt(session: PiRuntimeSession, message: string): Promise<PiRuntimePromptResult> | undefined {
    const prompt = this.beginPrompt(session, message)
    if (!prompt) return undefined
    void prompt.accepted.catch(() => undefined)
    return prompt.settled
  }

  getEditStatus(session: PiRuntimeSession, submissionId: string): PiEditStatus {
    return piEditStatus(readPiEditEntries(session.sessionFile), submissionId)
  }

  async editLast(session: PiRuntimeSession, input: PiEditLastInput, prepared?: PreparedInput): Promise<PiEditStatus> {
    const entries = readPiEditEntries(session.sessionFile)
    const record = entries.find((entry) => editRecord(entry)?.submissionId === input.submissionId)
    if (record) {
      if (editRecord(record)!.requestHash !== this.editHash(input)) throw new PiSessionEditError('SUBMISSION_CONFLICT', '同一提交标识不能用于不同的编辑内容。')
      if (piEditStatus(entries, input.submissionId).status === 'pending' && !this.locks.has(session.id)) await this.resume(session)
      return this.getEditStatus(session, input.submissionId)
    }
    if (input.attachmentIds?.length && !prepared) throw new AttachmentError('附件尚未准备完成，请重试。', 400)
    const queue = this.stateFor(session.id).queue.snapshot()
    if (queue.steering.length || queue.followUp.length || queue.inputs?.length || queue.steeringInputs?.length || this.extensionState.hasDialogs(session.id)) throw new PiRuntimeBusyError()
    const prompt = this.beginPrompt(session, input.message || '请查看附件。', prepared ? { input, prepared } : undefined, undefined, input)
    if (!prompt) throw new PiRuntimeBusyError()
    void prompt.settled.catch(() => undefined)
    await prompt.accepted
    return this.getEditStatus(session, input.submissionId)
  }

  private editHash(input: PiEditLastInput) {
    return createHash('sha256').update(JSON.stringify([input.entryId, input.revision, input.message, input.attachmentIds ?? []])).digest('hex')
  }

  private async publishHistoryChange(session: PiRuntimeSession) {
    if (!existsSync(session.sessionFile)) return
    const entries = readPiEditEntries(session.sessionFile)
    const id = piEditBoundary(entries)
    const state = this.stateFor(session.id)
    if (!id || state.historyChange?.id === id) return
    const boundary = entries.find((entry) => entry.id === id)!
    const change = { id, entryId: editRecord(boundary)!.targetEntryId, revision: createHash('sha256').update(readFileSync(session.sessionFile)).digest('hex'), sequence: 0 }
    this.history.unpin(session)
    state.completedRun = undefined
    await this.streamFor(session.id).stream.publish({ sessionId: session.id, observedAt: new Date().toISOString(), event: { type: 'history_changed', change } }, (event) => {
      change.sequence = event.sequence
      event.event.extensionUi = this.getExtensionUiSnapshot(session.id)
      state.historyChange = { ...change }
    })
  }

  /** Starts a prompt while exposing the RPC-admission boundary to callers that create a session. Attachment input must arrive already prepared so validation never hides inside prompt execution. */
  beginPrompt(session: PiRuntimeSession, message: string, attachments?: { input: AttachmentInput; prepared: PreparedInput }, initialSettings?: PiSessionInitialSettings, edit?: PiEditLastInput): PiRuntimePrompt | undefined {
    if (this.sessionAccessError(session.id) || this.settingsUpdating || this.locks.has(session.id) || this.extensionCommands.has(session.id)) return undefined
    this.cancelUnload(session.id)
    this.locks.set(session.id, 'prompt')
    const state = this.stateFor(session.id)
    const runId = randomUUID()
    const activeTurn: ActiveTurn = { ...(edit ? { editPreparing: true } : {}), prompt: message, runId, startedAt: new Date().toISOString() }
    state.activeTurn = activeTurn

    let resolveAccepted: (disposition: PiPromptDisposition) => void = () => undefined
    let rejectAccepted: (cause: unknown) => void = () => undefined
    const accepted = new Promise<PiPromptDisposition>((resolve, reject) => {
      resolveAccepted = resolve
      rejectAccepted = reject
    })
    let rejected = false
    let handledWithoutAgent = false
    const settled = this.projectionsReady.then(() => this.getOrCreate(session))
      .then(async (entry) => {
        this.expiredStreams.delete(session.id)
        this.streamFor(session.id)
        this.transition(session.id, 'loading')
        this.transition(session.id, 'active')
        this.touch(session.id)
        if (edit) {
          await entry.host.start()
          if (activeTurn.cancelEdit) throw new PiSessionEditError('EDIT_CANCELLED', '编辑已停止，原会话已保留。')
          await this.publishHistoryChange(session)
          const bytes = readFileSync(session.sessionFile)
          if (createHash('sha256').update(bytes).digest('hex') !== edit.revision) throw new PiSessionEditError('HISTORY_REVISION_CHANGED', '会话历史已变化，请刷新后重新编辑。')
          const last = entryPath(readPiEditEntries(session.sessionFile)).findLast((item) => item.type === 'message' && item.message.role === 'user')
          if (last?.id !== edit.entryId) throw new PiSessionEditError('INVALID_EDIT_TARGET', '只能编辑当前分支最后一条用户消息。')
          const commands = (await entry.host.command({ type: 'get_commands' })).data as { commands?: { name: string; source: string }[] }
          const commandName = message.trimStart().match(/^\/([^\s/]+)/)?.[1]
          if (commandName && commands.commands?.some((item) => item.name === commandName && item.source === 'extension')) throw new PiSessionEditError('INVALID_COMMAND', '编辑重发不能执行插件控制命令。')
          if (attachments) {
            this.attachments.check(session.id, attachments.input)
            const state = (await entry.host.command({ type: 'get_state' })).data as { model?: { input?: string[] } }
            if (attachments.prepared.images?.length && state.model?.input && !state.model.input.includes('image')) throw new AttachmentError('当前模型不支持图片输入。', 400)
          }
          await this.extensionState.clearProjection(session.id)
          const selected = (await entry.host.command({ type: 'pi_nest_edit', action: 'prepare', entryId: edit.entryId, revision: edit.revision, submissionId: edit.submissionId, requestHash: this.editHash(edit), runId })).data as { phase?: string }
          if (selected.phase !== 'selected') {
            await entry.host.command({ type: 'pi_nest_edit', action: 'recover' })
            await this.publishHistoryChange(session)
            throw new PiSessionEditError('EDIT_CANCELLED', '编辑被扩展取消，原会话已保留。')
          }
          await this.publishHistoryChange(session)
        }
        if (initialSettings) {
          await entry.host.start()
          if (initialSettings.model) await entry.host.command({ type: 'set_model', provider: initialSettings.model.provider, modelId: initialSettings.model.id })
          if (initialSettings.thinkingLevel !== undefined) {
            const response = await entry.host.command({ type: 'get_available_thinking_levels' })
            const levels = (response.data as { levels?: unknown } | undefined)?.levels
            if (!Array.isArray(levels) || !levels.includes(initialSettings.thinkingLevel)) throw new Error('所选模型不支持该思考等级，请重新选择。')
            await entry.host.command({ type: 'set_thinking_level', level: initialSettings.thinkingLevel })
          }
        }
        this.history.pin(session, runId)
        if (attachments) this.attachments.check(session.id, attachments.input)
        const payload: PreparedInput = attachments?.prepared ?? { message }
        if (edit && activeTurn.cancelEdit) {
          await entry.host.command({ type: 'pi_nest_edit', action: 'recover' })
          await this.publishHistoryChange(session)
          throw new PiSessionEditError('EDIT_CANCELLED', '编辑已停止，原会话已恢复。')
        }
        activeTurn.editPreparing = false
        const prompt = entry.host.beginPrompt(payload.message, payload.images)
        let nativeSettled = false
        void prompt.settled.then(() => { nativeSettled = true }, () => { nativeSettled = true })
        const confirmation = prompt.accepted.then(async (disposition) => {
          if (edit) {
            const deadline = Date.now() + 30_000
            while (this.getEditStatus(session, edit.submissionId).status === 'pending') {
              if (nativeSettled) {
                await entry.host.command({ type: 'pi_nest_edit', action: 'recover' })
                await this.publishHistoryChange(session)
                throw new PiSessionEditError('EDIT_CANCELLED', '输入未形成新消息，已恢复原会话。')
              }
              if (Date.now() >= deadline) throw new PiSessionEditError('EDIT_RECOVERY_REQUIRED', '正在确认发送状态，请勿重复发送。')
              await new Promise((done) => setTimeout(done, 25))
            }
            resolveAccepted(disposition)
            return
          }
          if (disposition === 'handled' && !activeTurn.agentStarted && state.activeTurn === activeTurn) {
            this.history.unpin(session)
            state.activeTurn = undefined
            this.locks.set(session.id, 'mutation')
            handledWithoutAgent = true
          } else resolveAccepted(disposition)
        })
        void confirmation.catch(rejectAccepted)
        return prompt.settled.then(async (result) => { await confirmation; return result })
      })
      .then((result) => {
        if (handledWithoutAgent) {
          if (this.locks.get(session.id) === 'mutation') this.locks.delete(session.id)
          this.transition(session.id, state.activeTurn ? 'active' : 'idle')
          this.scheduleUnload(session.id)
          resolveAccepted('handled')
        }
        if (state.activeTurn === activeTurn) this.settleActiveTurn(session.id, activeTurn, result.stopReason, true)
        return result
      })
      .catch(async (cause) => {
        if (cause instanceof PiRuntimeCapacityError) throw cause
        if (cause instanceof AttachmentError || cause instanceof PiSessionEditError) {
          // A rejected input is not a runtime failure: keep the session, its runtime and its projections intact.
          rejected = true
          this.transition(session.id, 'idle')
          throw cause
        }
        this.fail(session.id, cause)
        await this.remove(session.id, 'failed')
        throw cause
      })
      .finally(() => {
        if (handledWithoutAgent && this.locks.get(session.id) === 'mutation') this.locks.delete(session.id)
        if (state.activeTurn === activeTurn) {
          this.history.unpin(session)
          state.activeTurn = undefined
          this.locks.delete(session.id)
          this.scheduleUnload(session.id)
        }
        // A rejected input leaves the queue untouched until the caller restores it, so draining here would reorder the queue.
        if (!rejected) void this.drainFollowUp(session.id)
      })
    const completion = this.trackIdleOperation(session.id, settled)
    void completion.catch(rejectAccepted)
    return {
      accepted,
      runId,
      settled: completion,
    }
  }

  async abort(sessionId: string) {
    if (!this.isPromptActive(sessionId) && !this.compacting.has(sessionId)) return false
    const activeTurn = this.stateFor(sessionId).activeTurn
    if (activeTurn?.editPreparing) {
      activeTurn.cancelEdit = true
      await this.entries.get(sessionId)?.host.abort()
      return true
    }
    const previous = activeTurn?.stopReason
    if (activeTurn) activeTurn.stopReason = 'aborted'
    try {
      const aborted = (await this.entries.get(sessionId)?.host.abort()) ?? false
      if (!aborted && activeTurn) activeTurn.stopReason = previous
      return aborted
    } catch (cause) {
      if (activeTurn) activeTurn.stopReason = previous
      throw cause
    }
  }

  beginMutation(sessionId: string, beforeUnload?: () => void): Promise<(() => void) | undefined> | undefined {
    if (this.sessionAccessError(sessionId) || this.settingsUpdating || this.locks.has(sessionId) || this.extensionCommands.has(sessionId)) return undefined
    this.locks.set(sessionId, 'mutation')

    return this.projectionsReady.then(async () => {
      try {
        beforeUnload?.()
        await this.remove(sessionId, 'mutation')
        return () => {
          if (this.locks.get(sessionId) === 'mutation') {
            this.locks.delete(sessionId)
            this.scheduleUnload(sessionId)
          }
        }
      } catch (cause) {
        this.locks.delete(sessionId)
        throw cause
      }
    })
  }

  async deleteIdleSession(sessionId: string, removeFile: () => Promise<unknown>) {
    const accessError = this.sessionAccessError(sessionId)
    if (accessError) throw accessError
    const busyError = () => {
      if (this.states.get(sessionId)?.activeTurn || this.isPromptActive(sessionId)) return new PiSessionDeletionError('SESSION_RUNNING', 409, 'Pi 会话正在执行任务，请等待任务结束后删除。')
      return new PiSessionDeletionError('SESSION_BUSY', 409, 'Pi 会话正在处理其他操作，请稍后重试。')
    }
    const busy = () => {
      const state = this.states.get(sessionId)
      const lock = this.locks.get(sessionId)
      return this.settingsUpdating || this.extensionCommands.has(sessionId) || this.extensionResponses.has(sessionId)
        || [...this.idleOperations.get(sessionId) ?? []].some((operation) => operation.lock === 'mutation')
        || state?.promotingInput || state?.activeTurn || (lock !== undefined && lock !== 'read' && lock !== 'resume')
    }
    if (busy()) throw busyError()
    this.deleting.add(sessionId)
    this.cancelUnload(sessionId)
    let ownsLock = false
    let timer: NodeJS.Timeout | undefined
    try {
      const operations = this.idleOperations.get(sessionId)
      if (operations?.size) {
        await Promise.race([
          Promise.allSettled([...operations].map((operation) => operation.promise)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new PiSessionDeletionError('SESSION_DELETE_TIMEOUT', 503, '等待会话初始化或查询结束超时，会话文件已保留，请稍后重试。')), this.runtimeStartTimeoutMs)
          }),
        ])
        clearTimeout(timer)
      }
      if (busy() || this.locks.has(sessionId)) throw busyError()
      this.locks.set(sessionId, 'mutation')
      ownsLock = true
      try { await this.remove(sessionId, 'mutation') }
      catch (cause) {
        console.error('Failed to close Pi session for deletion', { sessionId, cause })
        throw new PiSessionDeletionError('SESSION_CLOSE_FAILED', 503, '无法确认会话进程已退出，会话文件已保留，请稍后重试。')
      }
      await removeFile()
      // shortcut: Block stale bindings until restart; revisit when restoring deleted session IDs is supported.
      this.deleted.add(sessionId)
      try { await this.deleteSession(sessionId) }
      catch (cause) { console.error('Failed to clean up deleted Pi session', { sessionId, cause }) }
    } finally {
      clearTimeout(timer)
      if (ownsLock && this.locks.get(sessionId) === 'mutation') this.locks.delete(sessionId)
      this.deleting.delete(sessionId)
      if (!this.deleted.has(sessionId)) this.scheduleUnload(sessionId)
    }
  }

  async close() {
    await this.projectionsReady
    await Promise.all([...this.entries.keys()].map((sessionId) => this.remove(sessionId, 'shutdown')))
    this.locks.clear()
    this.deleted.clear()
    for (const state of this.states.values()) clearTimeout(state.unloadTimer)
    await Promise.all([...this.streams.values()].map(({ stream }) => stream.close()))
    this.streams.clear()
    this.expiredStreams.clear()
    this.states.clear()
    this.history.clear()
    await this.extensionState.close()
    await rm(await this.eventBufferDirectory, { force: true, recursive: true })
  }

  /** Clears daemon-only state after the persistent Pi session was deleted. */
  async deleteSession(sessionId: string) {
    try { await this.remove(sessionId, 'deleted') }
    finally {
      const state = this.states.get(sessionId)
      if (state) clearTimeout(state.unloadTimer)
      const stream = this.streams.get(sessionId)
      try { if (stream) await stream.stream.close() }
      finally {
        this.streams.delete(sessionId)
        this.expiredStreams.delete(sessionId)
        this.states.delete(sessionId)
        this.extensionState.forget(sessionId)
      }
    }
  }

  /** Returns a deep copy of the daemon-only extension UI projection. */
  getExtensionUiSnapshot(sessionId: string): PiRuntimeExtensionUi {
    const projection = this.extensionState.snapshot(sessionId)
    return !this.entries.has(sessionId) && projection.freshness === 'known' && (Object.keys(projection.statuses).length || Object.keys(projection.widgets).length)
      ? { ...projection, freshness: 'restored' as const } : projection
  }

  private async createBufferDirectory(directory: string | undefined) {
    const path = directory ?? await mkdtemp(join(tmpdir(), 'pi-nest-runtime-'))
    await mkdir(path, { mode: 0o700, recursive: true })
    await chmod(path, 0o700)
    return path
  }

  private async getOrCreate(session: PiRuntimeSession) {
    const current = this.entries.get(session.id)
    if (current) return current
    const result = this.admission.then(async () => {
      const existing = this.entries.get(session.id)
      if (existing) return existing
      await this.makeCapacity(session.id)
      await this.extensionState.clearProjection(session.id)
      const host = this.createHost(session)
      const entry: RegistryEntry = {
        failureUnsubscribe: () => undefined,
        host,
        session,
        lastUsed: ++this.usageClock,
        unsubscribe: host.onEvent((event) => {
          // Tag at native-event receipt, before asynchronous stream persistence can interleave a later prompt.
          let projectedEvent: PiRuntimeHostEvent
          try { this.attachments.observeNative(event.event, session); projectedEvent = this.attachments.project(event, session.id) }
          catch (cause) { this.fail(session.id, cause); return }
          const runId = this.beginNativeTurn(session.id, projectedEvent)
          if (event.event.type === 'queue_update') projectedEvent = { ...event, event: { type: 'queue_update', ...this.stateFor(session.id).queue.snapshot() } }
          void this.streamFor(session.id).stream.publish({ ...projectedEvent, ...(runId ? { runId } : {}) }, async (published) => {
            this.trackActiveTurn(session.id, published)
            this.trackExtensionDialog(session.id, published)
            await this.extensionState.trackProjection(session.id, published.event)
          })
        }),
      }
      entry.failureUnsubscribe = host.onFailure((failure) => { void this.handleHostFailure(session.id, entry, failure) })
      this.entries.set(session.id, entry)
      return entry
    })
    this.admission = result.then(() => undefined, () => undefined)
    return result
  }

  private async remove(sessionId: string, reason: UnloadReason, options: { expected?: RegistryEntry; preserveUnloadDeadline?: boolean } = {}) {
    const entry = this.entries.get(sessionId)
    if (options.expected && entry !== options.expected) return false
    if (entry) {
      if (this.extensionState.hasDialogs(sessionId)) await this.clearPendingExtensionDialogs(sessionId)
      await entry.host.close()
      this.entries.delete(sessionId)
      entry.unsubscribe()
      entry.failureUnsubscribe()
      this.stateFor(sessionId).queue.setNativeQueue([], [])
    }
    if (entry && (reason === 'failed' || reason === 'deleted')) this.history.unpin(entry.session)
    if (reason === 'failed' || reason === 'deleted') await this.extensionState.clearProjection(sessionId)
    if (reason === 'failed') {
      const state = this.stateFor(sessionId)
      if (state.queue.recoverAfterFailure()) await this.publishInputQueue(sessionId)
    }
    if (reason !== 'shutdown') this.transition(sessionId, 'notLoaded')
    if (reason !== 'shutdown' && !options.preserveUnloadDeadline) this.scheduleUnload(sessionId)
    return true
  }

  private async makeCapacity(sessionId: string) {
    if (this.entries.size < this.maxLoadedRuntimes) return
    const candidate = [...this.entries.entries()]
      .filter(([id, entry]) => id !== sessionId && !this.deleting.has(id) && this.stateFor(id).lifecycle === 'idle' && this.stateFor(id).subscribers.size === 0 && !this.locks.has(id) && !this.extensionCommands.has(id))
      .sort(([leftId, left], [rightId, right]) => left.lastUsed - right.lastUsed || leftId.localeCompare(rightId))[0]
    if (!candidate) throw new PiRuntimeCapacityError()
    await this.remove(candidate[0], 'capacityEvicted', { expected: candidate[1], preserveUnloadDeadline: true })
  }

  private touch(sessionId: string) {
    const entry = this.entries.get(sessionId)
    if (entry) entry.lastUsed = ++this.usageClock
  }

  private async handleHostFailure(sessionId: string, entry: RegistryEntry, failure: PiRuntimeHostFailure) {
    if (this.entries.get(sessionId) !== entry) return
    this.fail(sessionId, new PiRuntimeHostError(failure))
    await this.remove(sessionId, 'failed', { expected: entry })
  }

  private streamFor(sessionId: string) {
    let entry = this.streams.get(sessionId)
    if (!entry) {
      entry = { stream: new SessionEventStream(sessionId, this.eventBufferDirectory) }
      this.streams.set(sessionId, entry)
    }
    return entry
  }

  private cancelUnload(sessionId: string) {
    const state = this.stateFor(sessionId)
    clearTimeout(state.unloadTimer)
    state.unloadTimer = undefined
    state.unloadGeneration += 1
  }

  private scheduleUnload(sessionId: string) {
    if (this.sessionAccessError(sessionId)) return
    const state = this.stateFor(sessionId)
    if (state.subscribers.size > 0 || this.locks.has(sessionId) || this.extensionCommands.has(sessionId) || (state.lifecycle !== 'idle' && state.lifecycle !== 'notLoaded')) return
    clearTimeout(state.unloadTimer)
    const generation = ++state.unloadGeneration
    state.unloadTimer = setTimeout(() => { void this.expire(sessionId, generation) }, this.runtimeUnloadGraceMs)
    state.unloadTimer.unref()
  }

  private async expire(sessionId: string, generation: number) {
    if (this.sessionAccessError(sessionId)) return
    const state = this.stateFor(sessionId)
    if (state.unloadGeneration !== generation || state.subscribers.size > 0 || this.locks.has(sessionId) || this.extensionCommands.has(sessionId) || (state.lifecycle !== 'idle' && state.lifecycle !== 'notLoaded')) return
    state.unloadTimer = undefined
    if (state.lifecycle === 'idle') {
      await this.remove(sessionId, 'idleExpired')
      this.cancelUnload(sessionId)
    }
    const stream = this.streams.get(sessionId)
    if (!stream) return
    this.streams.delete(sessionId)
    this.expiredStreams.add(sessionId)
    await stream.stream.close()
  }

  private streamForSubscribe(sessionId: string, after: number | undefined) {
    if (after !== undefined && !this.streams.has(sessionId) && this.expiredStreams.has(sessionId) && after > 0) throw new PiRuntimeResumeError('RESUME_GAP')
    if (after === undefined || after === 0) this.expiredStreams.delete(sessionId)
    return this.streamFor(sessionId)
  }

  private trackExtensionDialog(sessionId: string, dialog: PiRuntimeEvent) {
    if (!this.extensionState.trackDialog(sessionId, dialog)) return
    const activeTurn = this.stateFor(sessionId).activeTurn
    if (activeTurn && activeTurn.runId === dialog.runId) {
      activeTurn.firstSequence = undefined
      activeTurn.waitingForExtension = true
    }
  }

  private stateFor(sessionId: string) {
    let state = this.states.get(sessionId)
    if (!state) {
      state = { queue: new SessionInputQueue(sessionId, this.attachments), lifecycle: 'notLoaded', listeners: new Set(), revision: 0, subscribers: new Map(), unloadGeneration: 0, unloadTimer: undefined }
      this.states.set(sessionId, state)
    }
    return state
  }

  private snapshot(sessionId: string, atSequence: number, replayAfter: number | undefined): PiRuntimeSessionSnapshot {
    const state = this.stateFor(sessionId)
    return {
      ...(state.historyChange ? { historyChange: state.historyChange } : {}),
      ...(state.activeTurn ? { activeTurn: { prompt: state.activeTurn.prompt, runId: state.activeTurn.runId, startedAt: state.activeTurn.startedAt, ...(state.activeTurn.waitingForExtension ? { waitingForExtension: true } : {}) } } : {}),
      ...(state.completedRun ? { completedRun: { ...state.completedRun } } : {}),
      atSequence,
      inputQueue: this.stateFor(sessionId).queue.snapshot(),
      extensionUi: this.getExtensionUiSnapshot(sessionId),
      pendingExtensionDialogs: this.extensionState.pendingDialogs(sessionId),
      ...(replayAfter !== undefined && replayAfter < atSequence ? { replayAfter } : {}),
      runtime: { thinkingLevel: this.entries.get(sessionId)?.host.currentThinkingLevel, ...(this.entries.get(sessionId)?.host.currentModel ? { model: this.entries.get(sessionId)!.host.currentModel } : {}), ...(state.error ? { error: state.error } : {}), ...(state.failureKind ? { failureKind: state.failureKind } : {}), lifecycle: state.lifecycle, revision: state.revision },
      sessionId,
    }
  }

  private async clearPendingExtensionDialogs(sessionId: string) {
    const ids = this.extensionState.clearDialogs(sessionId)
    await Promise.all(ids.map((id) => this.publishExtensionDialogResolved(sessionId, id)))
  }

  private async publishExtensionDialogResolved(sessionId: string, id: string) {
    await this.streamFor(sessionId).stream.publish({
      event: { dialogId: id, type: 'extension_ui_resolved' },
      observedAt: new Date().toISOString(),
      sessionId,
    })
  }

  /** Pi Extensions may start an agent through pi.sendUserMessage, bypassing beginPrompt. */
  private beginNativeTurn(sessionId: string, event: PiRuntimeHostEvent) {
    const state = this.stateFor(sessionId)
    if (event.event.type === 'queue_update' && Array.isArray(event.event.steering) && event.event.steering.every((message) => typeof message === 'string') && Array.isArray(event.event.followUp) && event.event.followUp.every((message) => typeof message === 'string')) {
      state.queue.setNativeQueue(event.event.steering, event.event.followUp)
    }
    const activeTurn = state.activeTurn
    if (activeTurn) {
      if (event.event.type === 'agent_start') activeTurn.agentStarted = true
      const stopReason = piAssistantStopReason(event.event)
      if (stopReason !== undefined) activeTurn.stopReason = stopReason
      if (event.event.type === 'agent_settled') {
        if (event.event.aborted === true) activeTurn.stopReason = 'aborted'
        this.settleActiveTurn(sessionId, activeTurn)
      }
      else if (activeTurn.waitingForExtension && this.resumesStreaming(event.event)) {
        activeTurn.firstSequence = undefined
        activeTurn.waitingForExtension = undefined
      }
      return activeTurn.runId
    }
    const message = event.event.message
    const isUserMessage = event.event.type === 'message' && isPiMessage(message, 'user')
    if (event.event.type !== 'agent_start' && !isUserMessage) return undefined
    this.cancelUnload(sessionId)
    const session = this.entries.get(sessionId)?.session
    state.activeTurn = { native: true, runId: randomUUID(), startedAt: event.observedAt }
    if (session) this.history.pin(session, state.activeTurn.runId, Boolean(isUserMessage))
    this.locks.set(sessionId, 'prompt')
    this.transition(sessionId, 'active')
    return state.activeTurn.runId
  }

  private settleActiveTurn(sessionId: string, activeTurn: ActiveTurn, stopReason = activeTurn.stopReason ?? 'stop', notifyCompletion = false) {
    const state = this.stateFor(sessionId)
    if (state.activeTurn !== activeTurn) return
    state.completedRun = { runId: activeTurn.runId, stopReason }
    state.activeTurn = undefined
    const session = this.entries.get(sessionId)?.session
    if (session) {
      try { this.history.unpin(session, activeTurn.runId) }
      catch (cause) { console.error('Failed to publish history snapshot', { sessionId, name: cause instanceof Error ? cause.name : 'Error' }) }
    }
    const operation = [...this.idleOperations.get(sessionId) ?? []].find((pending) => pending.lock)
    if (operation?.lock) this.locks.set(sessionId, operation.lock)
    else this.locks.delete(sessionId)
    this.transition(sessionId, 'idle', undefined, undefined, false, notifyCompletion ? state.completedRun : undefined)
    this.scheduleUnload(sessionId)
    if (activeTurn.native) queueMicrotask(() => { void this.drainFollowUp(sessionId) })
  }

  private publishInputQueue(sessionId: string) {
    return this.streamFor(sessionId).stream.publish({ sessionId, observedAt: new Date().toISOString(), event: { type: 'queue_update', ...this.stateFor(sessionId).queue.snapshot() } })
  }

  async resumeQueued(session: PiRuntimeSession, inputId: string) {
    const error = this.sessionAccessError(session.id)
    if (error) throw error
    const state = this.stateFor(session.id)
    if (state.promotingInput) throw new PiRuntimeBusyError()
    const input = state.queue.selectForRecovery(inputId)
    state.promotingInput = true
    try {
      const alreadyRecorded = state.queue.isRecorded(session, input)
      if (!alreadyRecorded) {
        let prepared: PreparedInput | undefined
        if (input.attachmentIds?.length) {
          try { prepared = await state.queue.prepare(input) }
          catch (cause) { this.rejectQueued(session.id, input, cause); throw cause }
        }
        if (!state.queue.contains(input)) throw new AttachmentError('待确认消息已变化。', 409)
        const prompt = this.beginPrompt(session, input.message, prepared ? { input: { ...input, attachmentIds: input.attachmentIds?.slice() }, prepared } : undefined)
        if (!prompt) throw new PiRuntimeBusyError()
        void prompt.settled.catch(() => undefined)
        await prompt.accepted
      }
      state.queue.retire(input)
      await this.publishInputQueue(session.id)
    } finally {
      state.promotingInput = false
      void this.drainFollowUp(session.id)
    }
  }

  /** Drops a queued follow-up at the user's request and returns it so the client can restore the text. */
  async dropQueued(sessionId: string, inputId: string): Promise<PiQueuedInput> {
    const error = this.sessionAccessError(sessionId)
    if (error) throw error
    const state = this.stateFor(sessionId)
    if (state.promotingInput) throw new PiRuntimeBusyError()
    const input = state.queue.selectForDrop(inputId)
    state.promotingInput = true
    try {
      const removed = state.queue.retire(input)!
      await this.publishInputQueue(sessionId)
      return removed
    } finally {
      state.promotingInput = false
      void this.drainFollowUp(sessionId)
    }
  }

  /** Marks a queued input as needing the user's attention; the failure belongs to that message, not to the session. */
  private rejectQueued(sessionId: string, input: QueuedInputView, cause: unknown) {
    if (this.stateFor(sessionId).queue.reject(input, cause)) void this.publishInputQueue(sessionId)
  }

  private async drainFollowUp(sessionId: string) {
    if (this.sessionAccessError(sessionId)) return
    const state = this.stateFor(sessionId)
    const entry = this.entries.get(sessionId)
    if (!entry || state.promotingInput || this.locks.has(sessionId) || this.extensionCommands.has(sessionId) || state.lifecycle !== 'idle' || state.completedRun?.stopReason === 'aborted' || state.completedRun?.stopReason === 'error') return
    const input = state.queue.nextForDelivery()
    if (!input) return
    state.promotingInput = true
    let promptStarted = false
    try {
      let prepared: PreparedInput | undefined
      try {
        if (input.attachmentIds?.length) prepared = await state.queue.prepare(input)
      } catch (cause) {
        this.rejectQueued(sessionId, input, cause)
        return
      }
      if (this.locks.has(sessionId) || !state.queue.isHead(input)) return
      const prompt = this.beginPrompt(entry.session, input.message, prepared ? { input: { ...input, attachmentIds: input.attachmentIds?.slice() }, prepared } : undefined)
      if (!prompt) return
      promptStarted = true
      void prompt.settled.catch(() => undefined)
      try { await prompt.accepted }
      catch (cause) {
        if (cause instanceof AttachmentError) this.rejectQueued(sessionId, input, cause)
        return
      }
      this.stateFor(sessionId).queue.acknowledge(input)
      await this.publishInputQueue(sessionId)
    } finally {
      state.promotingInput = false
      if (promptStarted) void this.drainFollowUp(sessionId)
    }
  }

  private trackActiveTurn(sessionId: string, event: PiRuntimeEvent) {
    const activeTurn = this.stateFor(sessionId).activeTurn
    if (activeTurn && !activeTurn.waitingForExtension && activeTurn.runId === event.runId && activeTurn.firstSequence === undefined) activeTurn.firstSequence = event.sequence
  }

  private resumesStreaming(event: Record<string, unknown>) {
    if (event.type === 'agent_start' || event.type === 'message_update') return true
    if (event.type !== 'message') return false
    const message = event.message
    return Boolean(message && typeof message === 'object' && !Array.isArray(message) && (message as Record<string, unknown>).role === 'assistant')
  }

  private transition(sessionId: string, lifecycle: PiRuntimeLifecycle, error?: string, failureKind?: PiRuntimeFailureKind, force = false, completedRun?: PiRuntimeStatus['completedRun']) {
    const state = this.stateFor(sessionId)
    if (!force && state.lifecycle === lifecycle && state.error === error && state.failureKind === failureKind) return
    state.lifecycle = lifecycle
    state.error = error
    state.failureKind = failureKind
    state.revision += 1
    const status: PiRuntimeStatus = { ...(completedRun ? { completedRun: { ...completedRun } } : {}), thinkingLevel: this.entries.get(sessionId)?.host.currentThinkingLevel, ...(this.entries.get(sessionId)?.host.currentModel ? { model: this.entries.get(sessionId)!.host.currentModel } : {}), ...(error ? { error } : {}), ...(failureKind ? { failureKind } : {}), lifecycle, revision: state.revision, sessionId }
    for (const listener of state.listeners) listener(status)
  }

  private fail(sessionId: string, cause: unknown) {
    const error = cause instanceof PiRuntimeHostError
      ? cause.failure
      : { kind: 'rpc_error' as const, message: cause instanceof Error && cause.message ? cause.message : 'Pi runtime failed' }
    this.transition(sessionId, 'failed', error.message, error.kind)
  }
}
