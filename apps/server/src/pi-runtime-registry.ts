import { AttachmentStore, AttachmentError } from './attachment-store.js'
import type { AttachmentInput, PiQueuedInput, PiSessionInitialSettings } from '@pi-nest/contracts'
import type { RuntimeLifecycle as PiRuntimeLifecycle, RuntimeStatus as PiRuntimeStatus, PiRuntimeExtensionUi, PiRuntimeSessionSnapshot } from '@pi-nest/contracts'
export type { RuntimeLifecycle as PiRuntimeLifecycle, RuntimeStatus as PiRuntimeStatus, PiRuntimeExtensionUi, PiRuntimeSessionSnapshot } from '@pi-nest/contracts'

import { capturePiSessionHistory, PiRpcCommandError } from '@pi-nest/pi-adapter'

import { SessionHistorySnapshots } from './session-history-snapshots.js'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiRuntimeHost, PiRuntimeHostError, type PiRuntimeEvent, type PiRuntimeFailureKind, type PiRuntimeHostEvent, type PiRuntimeHostFailure, type PiRuntimePromptResult, type PiRuntimeSession } from './pi-runtime-host.js'
import { ProjectionSidecarStore } from './projection-sidecar-store.js'
import { RuntimeExtensionState } from './runtime-extension-state.js'
import { PiRuntimeResumeError, type PiRuntimeStreamError, SessionEventStream } from './session-event-stream.js'

type HostFactory = (session: PiRuntimeSession) => PiRuntimeHost
type Lock = 'mutation' | 'prompt'
type RegistryEntry = { failureUnsubscribe: () => void; host: PiRuntimeHost; lastUsed: number; session: PiRuntimeSession; unsubscribe: () => void }
type StreamEntry = { stream: SessionEventStream }
type StreamListener = (event: PiRuntimeEvent) => void
type StreamErrorListener = (error: PiRuntimeStreamError) => void
type UnloadReason = 'capacityEvicted' | 'deleted' | 'failed' | 'idleExpired' | 'mutation' | 'settingsReload' | 'shutdown'
type ActiveTurn = { firstSequence?: number; native?: true; prompt?: string; runId: string; startedAt: string; stopReason?: string; waitingForExtension?: true }
type RuntimeState = {
  inputQueue?: PiRuntimeSessionSnapshot['inputQueue']
  queuedFollowUps?: PiQueuedInput[]
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

export type PiRuntimePrompt = { accepted: Promise<void>; runId: string; settled: Promise<PiRuntimePromptResult> }
type RuntimeStatusListener = (status: PiRuntimeStatus) => void

export class PiRuntimeBusyError extends Error {
  constructor() { super('Pi session is busy') }
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
  private readonly locks = new Map<string, Lock>()
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

  getSessionStatistics(sessionId: string) {
    return this.entries.get(sessionId)?.host.command({ type: 'get_session_stats' })
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
    if (!this.isPromptActive(sessionId)) return undefined
    const entry = this.entries.get(sessionId)
    if (!entry) return undefined
    if (command.type === 'follow_up') {
      if (typeof command.message !== 'string') throw new Error('Invalid follow-up')
      const state = this.stateFor(sessionId)
      state.queuedFollowUps ??= []
      const input: PiQueuedInput = { id: typeof command.submissionId === 'string' ? command.submissionId : randomUUID(), message: command.message, ...(Array.isArray(command.attachmentIds) ? { attachmentIds: command.attachmentIds as string[], submissionId: command.submissionId as string } : {}) }
      await this.attachments.prepare(sessionId, input)
      if (input.attachmentIds?.length) input.attachments = this.attachments.refs(input.attachmentIds, sessionId)
      return this.attachments.deliver(sessionId, input, async () => {
        if (!state.queuedFollowUps!.some((queued) => queued.id === input.id)) state.queuedFollowUps!.push(input)
        try { this.saveQueue(sessionId); await this.publishInputQueue(sessionId) }
        catch (cause) { state.queuedFollowUps = state.queuedFollowUps!.filter((queued) => queued.id !== input.id); throw cause }
        return { success: true }
      }, entry.session.sessionFile, 'follow_up')
    }
    if (command.type === 'steer_queued') {
      const state = this.stateFor(sessionId)
      const index = typeof command.inputId === 'string' ? state.queuedFollowUps?.findIndex((input) => input.id === command.inputId) ?? -1 : Number(command.index) - (state.inputQueue?.followUp.length ?? 0)
      const queue = state.queuedFollowUps
      if (state.promotingInput || !queue || index < 0 || queue[index]?.message !== command.message) throw new Error('Queued message has already changed')
      state.promotingInput = true
      try {
        const input = queue[index]!
        const prepared = await this.attachments.prepare(sessionId, input)
        const response = input.attachmentIds?.length ? await this.sendAttachmentSteering(sessionId, input, entry.host) : await entry.host.command({ type: 'steer', ...prepared })
        queue.splice(index, 1)
        this.saveQueue(sessionId)
        await this.publishInputQueue(sessionId)
        return response
      } finally {
        state.promotingInput = false
        this.drainFollowUp(sessionId)
      }
    }
    if (command.type === 'steer' && Array.isArray(command.attachmentIds)) {
      const input = command as AttachmentInput
      const prepared = await this.attachments.prepare(sessionId, input)
      return this.attachments.deliver(sessionId, input, () => this.sendAttachmentSteering(sessionId, input, entry.host, prepared), entry.session.sessionFile, 'steer')
    }
    return entry.host.command(command)
  }

  private async sendAttachmentSteering(sessionId: string, input: AttachmentInput, host: PiRuntimeHost, prepared?: Awaited<ReturnType<AttachmentStore['prepare']>>) {
    const payload = prepared ?? await this.attachments.prepare(sessionId, input)
    const pending: PiQueuedInput = { ...input, id: input.submissionId!, attachments: this.attachments.refs(input.attachmentIds ?? [], sessionId) }
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
        const queued = this.stateFor(sessionId).queuedFollowUps?.find((item) => item.id === pending.id)
        if (queued) { queued.recoveryRequired = true; this.saveQueue(sessionId) }
      }
      throw cause
    }
  }

  /** Serializes an idle-only RPC control command with other session mutations. */
  commandWhenIdle(session: PiRuntimeSession, command: Record<string, unknown>): Promise<Record<string, unknown> | undefined> | undefined {
    if (this.settingsUpdating || this.locks.has(session.id)) throw new PiRuntimeBusyError()
    if (!this.entries.has(session.id)) return undefined
    const readOnly = typeof command.type === 'string' && ['get_state', 'get_runtime_state', 'get_available_models', 'get_available_thinking_levels', 'get_commands'].includes(command.type)
    const previousModel = this.entries.get(session.id)?.host.currentModel
    const previousThinking = this.entries.get(session.id)?.host.currentThinkingLevel
    this.cancelUnload(session.id)
    this.locks.set(session.id, 'mutation')
    if (!readOnly) this.transition(session.id, 'loading')
    return this.projectionsReady.then(() => this.getOrCreate(session))
      .then((entry) => entry.host.command(command))
      .then((result) => {
        const host = this.entries.get(session.id)?.host
        const metadataChanged = host?.currentModel?.id !== previousModel?.id || host?.currentModel?.provider !== previousModel?.provider || host?.currentThinkingLevel !== previousThinking
        this.transition(session.id, 'idle', undefined, undefined, readOnly && metadataChanged)
        this.touch(session.id)
        return result
      })
      .catch(async (cause) => {
        if (cause instanceof PiRuntimeCapacityError) throw cause
        if (cause instanceof PiRpcCommandError) {
          this.transition(session.id, 'idle')
          throw cause
        }
        this.fail(session.id, cause)
        await this.remove(session.id, 'failed')
        throw cause
      })
      .finally(() => {
        this.locks.delete(session.id)
        this.scheduleUnload(session.id)
      })
  }

  async respondToExtension(sessionId: string, response: Record<string, unknown>) {
    const id = typeof response.id === 'string' ? response.id : undefined
    const pending = id ? this.extensionState.takeDialog(sessionId, id) : undefined
    if (!id || !pending) return false
    const entry = this.entries.get(sessionId)
    if (!entry) {
      pending.restore()
      return false
    }
    try {
      await entry.host.respondToExtension(response)
    } catch (cause) {
      pending.restore()
      throw cause
    }
    await this.publishExtensionDialogResolved(sessionId, id)
    return true
  }

  /** Prevents a global Settings write from racing any runtime start or active run. */
  beginGlobalSettingsUpdate() {
    if (this.settingsUpdating || this.locks.size > 0) return undefined
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
    if (this.settingsUpdating || this.locks.has(session.id)) return undefined
    const alreadyIdle = this.entries.has(session.id) && this.stateFor(session.id).lifecycle === 'idle'
    this.cancelUnload(session.id)
    this.locks.set(session.id, 'mutation')
    return this.projectionsReady.then(() => this.getOrCreate(session))
      .then(async (entry) => {
        this.expiredStreams.delete(session.id)
        this.streamFor(session.id)
        if (!alreadyIdle) this.transition(session.id, 'loading')
        return entry.host.start()
      })
      .then(() => { this.transition(session.id, 'idle'); this.touch(session.id) })
      .catch(async (cause) => {
        if (cause instanceof PiRuntimeCapacityError) throw cause
        this.fail(session.id, cause)
        await this.remove(session.id, 'failed')
        throw cause
      })
      .finally(() => {
        this.locks.delete(session.id)
        this.scheduleUnload(session.id)
      })
  }

  startPrompt(session: PiRuntimeSession, message: string): Promise<PiRuntimePromptResult> | undefined {
    const prompt = this.beginPrompt(session, message)
    if (!prompt) return undefined
    void prompt.accepted.catch(() => undefined)
    return prompt.settled
  }

  /** Starts a prompt while exposing the RPC-admission boundary to callers that create a session. */
  beginPrompt(session: PiRuntimeSession, message: string, input?: AttachmentInput, initialSettings?: PiSessionInitialSettings): PiRuntimePrompt | undefined {
    if (this.settingsUpdating || this.locks.has(session.id)) return undefined
    this.cancelUnload(session.id)
    this.locks.set(session.id, 'prompt')
    const state = this.stateFor(session.id)
    const runId = randomUUID()
    const activeTurn: ActiveTurn = { prompt: message, runId, startedAt: new Date().toISOString() }
    state.activeTurn = activeTurn

    let resolveAccepted: () => void = () => undefined
    let rejectAccepted: (cause: unknown) => void = () => undefined
    const accepted = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve
      rejectAccepted = reject
    })
    const settled = this.projectionsReady.then(() => this.getOrCreate(session))
      .then(async (entry) => {
        this.expiredStreams.delete(session.id)
        this.streamFor(session.id)
        this.transition(session.id, 'loading')
        this.transition(session.id, 'active')
        this.touch(session.id)
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
        const prepared = input ? await this.attachments.prepare(session.id, input) : { message }
        const prompt = entry.host.beginPrompt(prepared.message, prepared.images)
        void prompt.accepted.then(resolveAccepted, rejectAccepted)
        return prompt.settled
      })
      .then((result) => {
        if (state.activeTurn === activeTurn) this.settleActiveTurn(session.id, activeTurn, result.stopReason, true)
        return result
      })
      .catch(async (cause) => {
        if (cause instanceof PiRuntimeCapacityError) throw cause
        this.fail(session.id, cause)
        await this.remove(session.id, 'failed')
        throw cause
      })
      .finally(() => {
        if (state.activeTurn === activeTurn) {
          this.history.unpin(session)
          state.activeTurn = undefined
          this.locks.delete(session.id)
          this.scheduleUnload(session.id)
        }
        this.drainFollowUp(session.id)
      })
    void settled.catch(rejectAccepted)
    return {
      accepted,
      runId,
      settled,
    }
  }

  async abort(sessionId: string) {
    if (!this.isPromptActive(sessionId)) return false
    const activeTurn = this.stateFor(sessionId).activeTurn
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

  beginMutation(sessionId: string): Promise<(() => void) | undefined> | undefined {
    if (this.settingsUpdating || this.locks.has(sessionId)) return undefined
    this.locks.set(sessionId, 'mutation')

    return this.projectionsReady.then(async () => {
      try {
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

  async close() {
    await this.projectionsReady
    await Promise.all([...this.entries.keys()].map((sessionId) => this.remove(sessionId, 'shutdown')))
    this.locks.clear()
    for (const state of this.states.values()) clearTimeout(state.unloadTimer)
    await Promise.all([...this.streams.values()].map(({ stream }) => stream.close()))
    this.streams.clear()
    this.expiredStreams.clear()
    this.states.clear()
    this.history.clear()
    this.extensionState.close()
    await rm(await this.eventBufferDirectory, { force: true, recursive: true })
  }

  /** Clears daemon-only state after the persistent Pi session was deleted. */
  async deleteSession(sessionId: string) {
    await this.remove(sessionId, 'deleted')
    const state = this.states.get(sessionId)
    if (state) clearTimeout(state.unloadTimer)
    const stream = this.streams.get(sessionId)
    if (stream) {
      this.streams.delete(sessionId)
      await stream.stream.close()
    }
    this.expiredStreams.delete(sessionId)
    this.states.delete(sessionId)
    this.extensionState.forget(sessionId)
  }

  /** Returns a deep copy of the daemon-only extension UI projection. */
  getExtensionUiSnapshot(sessionId: string): PiRuntimeExtensionUi {
    return this.extensionState.snapshot(sessionId)
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
          if (event.event.type === 'queue_update') projectedEvent = { ...event, event: { type: 'queue_update', ...this.inputQueueFor(session.id) } }
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
      this.entries.delete(sessionId)
      if (this.extensionState.hasDialogs(sessionId)) await this.clearPendingExtensionDialogs(sessionId)
      entry.unsubscribe()
      entry.failureUnsubscribe()
      await entry.host.close()
      this.stateFor(sessionId).inputQueue = { steering: [], followUp: [] }
    }
    if (entry && (reason === 'failed' || reason === 'deleted')) this.history.unpin(entry.session)
    if (reason === 'failed' || reason === 'deleted') await this.extensionState.clearProjection(sessionId)
    if (reason === 'failed') {
      const state = this.stateFor(sessionId)
      const pending = [...(state.queuedFollowUps ?? []), ...this.attachments.steering(sessionId)]
      state.queuedFollowUps = [...new Map(pending.map((input) => [input.id, { ...input, recoveryRequired: true }])).values()]
      if (state.queuedFollowUps.length) { this.saveQueue(sessionId); await this.publishInputQueue(sessionId) }
    }
    if (reason !== 'shutdown') this.transition(sessionId, 'notLoaded')
    if (reason !== 'shutdown' && !options.preserveUnloadDeadline) this.scheduleUnload(sessionId)
    return true
  }

  private async makeCapacity(sessionId: string) {
    if (this.entries.size < this.maxLoadedRuntimes) return
    const candidate = [...this.entries.entries()]
      .filter(([id, entry]) => id !== sessionId && this.stateFor(id).lifecycle === 'idle' && this.stateFor(id).subscribers.size === 0 && !this.locks.has(id))
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
    const state = this.stateFor(sessionId)
    if (state.subscribers.size > 0 || this.locks.has(sessionId) || (state.lifecycle !== 'idle' && state.lifecycle !== 'notLoaded')) return
    clearTimeout(state.unloadTimer)
    const generation = ++state.unloadGeneration
    state.unloadTimer = setTimeout(() => { void this.expire(sessionId, generation) }, this.runtimeUnloadGraceMs)
    state.unloadTimer.unref()
  }

  private async expire(sessionId: string, generation: number) {
    const state = this.stateFor(sessionId)
    if (state.unloadGeneration !== generation || state.subscribers.size > 0 || this.locks.has(sessionId) || (state.lifecycle !== 'idle' && state.lifecycle !== 'notLoaded')) return
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
      const restored = [...this.attachments.queue(sessionId), ...this.attachments.steering(sessionId)]
      const unique = [...new Map(restored.map((input) => [input.id, input])).values()]
      state = { queuedFollowUps: unique.map((input) => ({ ...input, recoveryRequired: true })), lifecycle: 'notLoaded', listeners: new Set(), revision: 0, subscribers: new Map(), unloadGeneration: 0, unloadTimer: undefined }
      this.states.set(sessionId, state)
    }
    return state
  }

  private snapshot(sessionId: string, atSequence: number, replayAfter: number | undefined): PiRuntimeSessionSnapshot {
    const state = this.stateFor(sessionId)
    return {
      ...(state.activeTurn ? { activeTurn: { prompt: state.activeTurn.prompt, runId: state.activeTurn.runId, startedAt: state.activeTurn.startedAt, ...(state.activeTurn.waitingForExtension ? { waitingForExtension: true } : {}) } } : {}),
      ...(state.completedRun ? { completedRun: { ...state.completedRun } } : {}),
      atSequence,
      inputQueue: this.inputQueueFor(sessionId),
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
      state.inputQueue = { steering: [...event.event.steering], followUp: [...event.event.followUp] }
    }
    const activeTurn = state.activeTurn
    if (activeTurn) {
      const message = event.event.message
      if (event.event.type === 'message_end' && message && typeof message === 'object' && !Array.isArray(message)) {
        const assistant = message as Record<string, unknown>
        if (assistant.role === 'assistant' && typeof assistant.stopReason === 'string') activeTurn.stopReason = assistant.stopReason
      }
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
    const isUserMessage = event.event.type === 'message' && message && typeof message === 'object' && !Array.isArray(message) && (message as Record<string, unknown>).role === 'user'
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
    this.locks.delete(sessionId)
    this.transition(sessionId, 'idle', undefined, undefined, false, notifyCompletion ? state.completedRun : undefined)
    this.scheduleUnload(sessionId)
    if (activeTurn.native) queueMicrotask(() => this.drainFollowUp(sessionId))
  }

  private inputQueueFor(sessionId: string) {
    const state = this.stateFor(sessionId)
    const nativeSteering = state.inputQueue?.steering ?? []
    const pendingSteering = this.attachments.steering(sessionId)
    return {
      steering: nativeSteering.map((text) => this.attachments.displayPrompt(text, sessionId) ?? text),
      followUp: [...(state.inputQueue?.followUp ?? []).map((text) => this.attachments.displayPrompt(text, sessionId) ?? text), ...(state.queuedFollowUps ?? []).map((input) => input.message)],
      ...((state.queuedFollowUps ?? []).some((input) => input.attachmentIds?.length || input.recoveryRequired) ? { inputs: state.queuedFollowUps?.map((input) => ({ ...input })) } : {}),
      ...(pendingSteering.length && nativeSteering.length ? { steeringInputs: nativeSteering.map((text, index) => {
        const saved = pendingSteering.find((input) => input.submissionId && text.includes(input.submissionId))
        return saved ? { ...saved } : { id: `native-steer:${index}`, message: this.attachments.displayPrompt(text, sessionId) ?? text }
      }) } : {}),
    }
  }

  private publishInputQueue(sessionId: string) {
    return this.streamFor(sessionId).stream.publish({ sessionId, observedAt: new Date().toISOString(), event: { type: 'queue_update', ...this.inputQueueFor(sessionId) } })
  }

  private saveQueue(sessionId: string) { this.attachments.queue(sessionId, this.stateFor(sessionId).queuedFollowUps ?? []) }

  async resumeQueued(session: PiRuntimeSession, inputId: string) {
    const queue = this.stateFor(session.id).queuedFollowUps
    const input = queue?.find((input) => input.id === inputId)
    if (!input || !input.recoveryRequired) throw new AttachmentError('待确认消息已变化。', 409)
    const alreadyRecorded = input.submissionId && capturePiSessionHistory({ sessionFile: session.sessionFile, expectedSessionId: session.id, expectedCwd: session.cwd }).entries.some((entry) => {
      if (entry.type !== 'message' || entry.message.role !== 'user') return false
      const content = entry.message.content
      const text = typeof content === 'string' ? content : content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
      return text.includes(`<pi-nest-attachments id="${input.submissionId}">`)
    })
    if (alreadyRecorded) {
      queue!.splice(queue!.indexOf(input), 1)
      this.attachments.steering(session.id, this.attachments.steering(session.id).filter((item) => item.id !== input.id))
      this.saveQueue(session.id)
      await this.publishInputQueue(session.id)
      return
    }
    const prompt = this.beginPrompt(session, input.message, input)
    if (!prompt) throw new PiRuntimeBusyError()
    await prompt.accepted
    queue!.splice(queue!.indexOf(input), 1)
    this.attachments.steering(session.id, this.attachments.steering(session.id).filter((item) => item.id !== input.id))
    this.saveQueue(session.id)
    await this.publishInputQueue(session.id)
    void prompt.settled.catch(() => undefined)
  }

  private drainFollowUp(sessionId: string) {
    const state = this.stateFor(sessionId)
    const entry = this.entries.get(sessionId)
    if (!entry || state.promotingInput || this.locks.has(sessionId) || state.lifecycle !== 'idle' || state.completedRun?.stopReason === 'aborted' || state.completedRun?.stopReason === 'error') return
    const input = state.queuedFollowUps?.[0]
    if (!input || input.recoveryRequired) return
    const prompt = this.beginPrompt(entry.session, input.message, input)
    if (!prompt) return
    state.queuedFollowUps!.shift()
    void prompt.accepted.then(() => this.saveQueue(sessionId))
    void this.publishInputQueue(sessionId)
    void prompt.accepted.catch(() => {
      state.queuedFollowUps ??= []
      state.queuedFollowUps.unshift(input)
      this.saveQueue(sessionId)
      void this.publishInputQueue(sessionId)
    })
    void prompt.settled.catch(() => undefined)
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
