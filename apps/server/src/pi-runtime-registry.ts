import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiRuntimeHost, type PiRuntimeEvent, type PiRuntimePromptResult, type PiRuntimeSession } from './pi-runtime-host.js'
import { PiRuntimeResumeError, type PiRuntimeStreamError, SessionEventStream } from './session-event-stream.js'

type HostFactory = (session: PiRuntimeSession) => PiRuntimeHost
type Lock = 'mutation' | 'prompt'
type RegistryEntry = { host: PiRuntimeHost; unsubscribe: () => void }
type StreamEntry = { stream: SessionEventStream }
type StreamListener = (event: PiRuntimeEvent) => void
type StreamErrorListener = (error: PiRuntimeStreamError) => void
type UnloadReason = 'deleted' | 'failed' | 'idleExpired' | 'mutation' | 'settingsReload' | 'shutdown'
type ExtensionUiProjection = { statuses: Map<string, string>; widgets: Map<string, string[]> }
type RuntimeState = {
  error?: string
  extensionUi?: ExtensionUiProjection
  lifecycle: PiRuntimeLifecycle
  listeners: Set<RuntimeStatusListener>
  revision: number
  subscribers: Map<string, () => void>
  unloadGeneration: number
  unloadTimer: NodeJS.Timeout | undefined
}

export type PiRuntimeLifecycle = 'notLoaded' | 'loading' | 'idle' | 'active' | 'failed'
export type PiRuntimeStatus = { error?: string; lifecycle: PiRuntimeLifecycle; revision: number; sessionId: string }
export type PiRuntimeExtensionUi = {
  freshness: 'known' | 'unknown'
  statuses: Record<string, string>
  widgets: Record<string, string[]>
}
export type PiRuntimeSessionSnapshot = {
  atSequence: number
  extensionUi: PiRuntimeExtensionUi
  runtime: Omit<PiRuntimeStatus, 'sessionId'>
  sessionId: string
}
type RuntimeStatusListener = (status: PiRuntimeStatus) => void

function configuredUnloadGraceMs() {
  const value = process.env.PI_NEST_RUNTIME_UNLOAD_GRACE_MS
  if (value === undefined) return 30 * 60_000
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error('PI_NEST_RUNTIME_UNLOAD_GRACE_MS must be a positive integer')
  return Number(value)
}

export type PiRuntimeRegistryOptions = {
  createHost?: HostFactory
  eventBufferDirectory?: string
  runtimeUnloadGraceMs?: number
}

/** Single-process ownership and lifecycle manager for native Pi sessions. */
export class PiRuntimeRegistry {
  private readonly createHost: HostFactory
  private readonly entries = new Map<string, RegistryEntry>()
  private readonly eventBufferDirectory: Promise<string>
  private readonly expiredStreams = new Set<string>()
  private readonly locks = new Map<string, Lock>()
  private readonly pendingExtensionDialogs = new Map<string, Set<string>>()
  private readonly states = new Map<string, RuntimeState>()
  private settingsUpdating = false
  private readonly streams = new Map<string, StreamEntry>()

  constructor(options: PiRuntimeRegistryOptions = {}) {
    this.createHost = options.createHost ?? ((session) => new PiRuntimeHost(session))
    this.runtimeUnloadGraceMs = options.runtimeUnloadGraceMs ?? configuredUnloadGraceMs()
    this.eventBufferDirectory = this.createBufferDirectory(options.eventBufferDirectory)
  }

  private readonly runtimeUnloadGraceMs: number

  isPromptActive(sessionId: string) {
    return this.locks.get(sessionId) === 'prompt'
  }

  isAnyPromptActive() {
    return [...this.locks.values()].some((lock) => lock === 'prompt')
  }

  /** Runs an RPC command that is valid only while the agent is actively streaming. */
  async commandWhileRunning(sessionId: string, command: Record<string, unknown>) {
    if (!this.isPromptActive(sessionId)) return undefined
    const entry = this.entries.get(sessionId)
    if (!entry) return undefined
    return entry.host.command(command)
  }

  /** Serializes an idle-only RPC control command with other session mutations. */
  commandWhenIdle(session: PiRuntimeSession, command: Record<string, unknown>): Promise<Record<string, unknown> | undefined> | undefined {
    if (this.settingsUpdating || this.locks.has(session.id) || !this.entries.has(session.id)) return undefined
    this.cancelUnload(session.id)
    this.locks.set(session.id, 'mutation')
    this.transition(session.id, 'loading')
    return this.getOrCreate(session)
      .then((entry) => entry.host.command(command))
      .then((result) => {
        this.transition(session.id, 'idle')
        return result
      })
      .catch(async (cause) => {
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
    if (!id || !this.isPromptActive(sessionId) || !this.pendingExtensionDialogs.get(sessionId)?.has(id)) return false
    const entry = this.entries.get(sessionId)
    if (!entry) return false
    await entry.host.respondToExtension(response)
    this.pendingExtensionDialogs.get(sessionId)?.delete(id)
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
  ) {
    const state = this.stateFor(sessionId)
    this.cancelUnload(sessionId)
    const entry = this.streamForSubscribe(sessionId, after)
    let unsubscribeStatus: (() => void) | undefined
    const unsubscribe = await entry.stream.subscribeWithSnapshot(
      after,
      (atSequence) => this.snapshot(sessionId, atSequence),
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
    return this.watch(sessionId, `legacy:${Math.random()}`, after, listener, onError, onSnapshot, onStatus)
  }

  resume(session: PiRuntimeSession): Promise<void> | undefined {
    if (this.settingsUpdating || this.locks.has(session.id)) return undefined
    this.cancelUnload(session.id)
    this.expiredStreams.delete(session.id)
    this.streamFor(session.id)
    this.locks.set(session.id, 'mutation')
    this.transition(session.id, 'loading')
    return this.getOrCreate(session)
      .then((entry) => entry.host.start())
      .then(() => { this.transition(session.id, 'idle') })
      .catch(async (cause) => {
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
    if (this.settingsUpdating || this.locks.has(session.id)) return undefined
    this.cancelUnload(session.id)
    this.expiredStreams.delete(session.id)
    this.streamFor(session.id)
    this.locks.set(session.id, 'prompt')
    this.transition(session.id, 'loading')

    return this.getOrCreate(session)
      .then((entry) => {
        this.transition(session.id, 'active')
        return entry.host.prompt(message)
      })
      .then((result) => {
        this.transition(session.id, 'idle')
        return result
      })
      .catch(async (cause) => {
        this.fail(session.id, cause)
        await this.remove(session.id, 'failed')
        throw cause
      })
      .finally(() => {
        this.locks.delete(session.id)
        this.scheduleUnload(session.id)
      })
  }

  async abort(sessionId: string) {
    if (!this.isPromptActive(sessionId)) return false
    return (await this.entries.get(sessionId)?.host.abort()) ?? false
  }

  beginMutation(sessionId: string): Promise<(() => void) | undefined> | undefined {
    if (this.settingsUpdating || this.locks.has(sessionId)) return undefined
    this.locks.set(sessionId, 'mutation')

    return (async () => {
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
    })()
  }

  async close() {
    await Promise.all([...this.entries.keys()].map((sessionId) => this.remove(sessionId, 'shutdown')))
    this.locks.clear()
    this.pendingExtensionDialogs.clear()
    for (const state of this.states.values()) clearTimeout(state.unloadTimer)
    await Promise.all([...this.streams.values()].map(({ stream }) => stream.close()))
    this.streams.clear()
    this.expiredStreams.clear()
    this.states.clear()
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
  }

  /** Returns a deep copy of the daemon-only extension UI projection. */
  getExtensionUiSnapshot(sessionId: string): PiRuntimeExtensionUi {
    const extensionUi = this.stateFor(sessionId).extensionUi
    return extensionUi
      ? {
          freshness: 'known',
          statuses: Object.fromEntries(extensionUi.statuses),
          widgets: Object.fromEntries([...extensionUi.widgets].map(([key, lines]) => [key, [...lines]])),
        }
      : { freshness: 'unknown', statuses: {}, widgets: {} }
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

    const host = this.createHost(session)
    const entry: RegistryEntry = {
      host,
      unsubscribe: host.onEvent((event) => {
        void this.streamFor(session.id).stream.publish(event, (published) => {
          this.trackExtensionDialog(session.id, published.event)
          this.trackExtensionUi(session.id, published.event)
        })
      }),
    }
    this.entries.set(session.id, entry)
    return entry
  }

  private async remove(sessionId: string, reason: UnloadReason) {
    const entry = this.entries.get(sessionId)
    if (entry) {
      this.entries.delete(sessionId)
      this.pendingExtensionDialogs.delete(sessionId)
      entry.unsubscribe()
      await entry.host.close()
    }
    if (reason === 'failed' || reason === 'deleted') this.clearExtensionUi(sessionId)
    if (reason !== 'shutdown') this.transition(sessionId, 'notLoaded')
    if (reason !== 'shutdown') this.scheduleUnload(sessionId)
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

  private streamForSubscribe(sessionId: string, after: number) {
    if (!this.streams.has(sessionId) && this.expiredStreams.has(sessionId) && after > 0) throw new PiRuntimeResumeError('RESUME_GAP')
    if (after === 0) this.expiredStreams.delete(sessionId)
    return this.streamFor(sessionId)
  }

  private trackExtensionDialog(sessionId: string, event: Record<string, unknown>) {
    if (event.type !== 'extension_ui_request' || typeof event.id !== 'string') return
    const method = event.method
    if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') return
    const pending = this.pendingExtensionDialogs.get(sessionId) ?? new Set<string>()
    pending.add(event.id)
    this.pendingExtensionDialogs.set(sessionId, pending)
  }

  private stateFor(sessionId: string) {
    let state = this.states.get(sessionId)
    if (!state) {
      state = { lifecycle: 'notLoaded', listeners: new Set(), revision: 0, subscribers: new Map(), unloadGeneration: 0, unloadTimer: undefined }
      this.states.set(sessionId, state)
    }
    return state
  }

  private snapshot(sessionId: string, atSequence: number): PiRuntimeSessionSnapshot {
    const state = this.stateFor(sessionId)
    return {
      atSequence,
      extensionUi: this.getExtensionUiSnapshot(sessionId),
      runtime: { ...(state.error ? { error: state.error } : {}), lifecycle: state.lifecycle, revision: state.revision },
      sessionId,
    }
  }

  private transition(sessionId: string, lifecycle: PiRuntimeLifecycle, error?: string) {
    const state = this.stateFor(sessionId)
    if (state.lifecycle === lifecycle && state.error === error) return
    state.lifecycle = lifecycle
    state.error = error
    state.revision += 1
    const status: PiRuntimeStatus = { ...(error ? { error } : {}), lifecycle, revision: state.revision, sessionId }
    for (const listener of state.listeners) listener(status)
  }

  private fail(sessionId: string, cause: unknown) {
    const error = cause instanceof Error && cause.message ? cause.message : 'Pi runtime failed'
    this.transition(sessionId, 'failed', error)
  }

  private clearExtensionUi(sessionId: string) {
    const state = this.stateFor(sessionId)
    state.extensionUi = { statuses: new Map(), widgets: new Map() }
  }

  private trackExtensionUi(sessionId: string, event: Record<string, unknown>) {
    const state = this.stateFor(sessionId)
    const type = event.type === 'extension_ui_request' ? event.method : event.type
    if (type === 'setStatus') {
      const key = event.statusKey
      if (typeof key !== 'string' || !key) return
      const projection = state.extensionUi ?? { statuses: new Map(), widgets: new Map() }
      state.extensionUi = projection
      if (typeof event.statusText === 'string') projection.statuses.set(key, event.statusText)
      else projection.statuses.delete(key)
      return
    }
    if (type !== 'setWidget') return
    const key = event.widgetKey
    if (typeof key !== 'string' || !key) return
    const projection = state.extensionUi ?? { statuses: new Map(), widgets: new Map() }
    state.extensionUi = projection
    if (Array.isArray(event.widgetLines) && event.widgetLines.every((line) => typeof line === 'string')) projection.widgets.set(key, [...event.widgetLines])
    else projection.widgets.delete(key)
  }
}
