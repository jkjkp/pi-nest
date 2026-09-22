import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiRuntimeHost, type PiRuntimeEvent, type PiRuntimePromptResult, type PiRuntimeSession } from './pi-runtime-host.js'
import { PiRuntimeResumeError, type PiRuntimeStreamError, SessionEventStream } from './session-event-stream.js'

type HostFactory = (session: PiRuntimeSession) => PiRuntimeHost
type Lock = 'mutation' | 'prompt'
type RegistryEntry = { host: PiRuntimeHost; idleTimer: NodeJS.Timeout | undefined; unsubscribe: () => void }
type StreamEntry = { idleTimer: NodeJS.Timeout | undefined; stream: SessionEventStream }
type StreamListener = (event: PiRuntimeEvent) => void
type StreamErrorListener = (error: PiRuntimeStreamError) => void

export type PiRuntimeRegistryOptions = {
  createHost?: HostFactory
  eventBufferDirectory?: string
  eventRetentionMs?: number
  idleTimeoutMs?: number
}

/** Single-process ownership and lifecycle manager for native Pi sessions. */
export class PiRuntimeRegistry {
  private readonly createHost: HostFactory
  private readonly entries = new Map<string, RegistryEntry>()
  private readonly eventBufferDirectory: Promise<string>
  private readonly eventRetentionMs: number
  private readonly expiredStreams = new Set<string>()
  private readonly idleTimeoutMs: number
  private readonly locks = new Map<string, Lock>()
  private readonly pendingExtensionDialogs = new Map<string, Set<string>>()
  private settingsUpdating = false
  private readonly streams = new Map<string, StreamEntry>()

  constructor(options: PiRuntimeRegistryOptions = {}) {
    this.createHost = options.createHost ?? ((session) => new PiRuntimeHost(session))
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000
    this.eventRetentionMs = options.eventRetentionMs ?? 600_000
    this.eventBufferDirectory = this.createBufferDirectory(options.eventBufferDirectory)
  }

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
    if (this.settingsUpdating || this.locks.has(session.id)) return undefined
    this.expiredStreams.delete(session.id)
    this.streamFor(session.id)
    this.locks.set(session.id, 'mutation')
    return this.getOrCreate(session)
      .then((entry) => entry.host.command(command))
      .finally(() => {
        this.locks.delete(session.id)
        this.scheduleIdleClose(session.id)
        this.scheduleStreamExpiry(session.id)
      })
      .catch(async (cause) => {
        await this.remove(session.id)
        throw cause
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
        if (reload) await Promise.all([...this.entries.keys()].map((sessionId) => this.remove(sessionId)))
      } finally {
        this.settingsUpdating = false
      }
    }
  }

  async subscribe(sessionId: string, after: number, listener: StreamListener, onError: StreamErrorListener) {
    const entry = this.streamForSubscribe(sessionId, after)
    this.cancelStreamExpiry(sessionId)
    const unsubscribe = await entry.stream.subscribe(after, listener, onError)
    return () => {
      unsubscribe()
      this.scheduleStreamExpiry(sessionId)
    }
  }

  startPrompt(session: PiRuntimeSession, message: string): Promise<PiRuntimePromptResult> | undefined {
    if (this.settingsUpdating || this.locks.has(session.id)) return undefined
    this.expiredStreams.delete(session.id)
    this.streamFor(session.id)
    this.locks.set(session.id, 'prompt')

    return this.getOrCreate(session)
      .then((entry) => entry.host.prompt(message))
      .finally(() => {
        this.locks.delete(session.id)
        this.scheduleIdleClose(session.id)
        this.scheduleStreamExpiry(session.id)
      })
      .catch(async (cause) => {
        await this.remove(session.id)
        throw cause
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
        await this.remove(sessionId)
        return () => {
          if (this.locks.get(sessionId) === 'mutation') {
            this.locks.delete(sessionId)
            this.scheduleStreamExpiry(sessionId)
          }
        }
      } catch (cause) {
        this.locks.delete(sessionId)
        throw cause
      }
    })()
  }

  async close() {
    await Promise.all([...this.entries.keys()].map((sessionId) => this.remove(sessionId)))
    this.locks.clear()
    this.pendingExtensionDialogs.clear()
    await Promise.all([...this.streams.values()].map(({ idleTimer, stream }) => {
      clearTimeout(idleTimer)
      return stream.close()
    }))
    this.streams.clear()
    this.expiredStreams.clear()
    await rm(await this.eventBufferDirectory, { force: true, recursive: true })
  }

  private async createBufferDirectory(directory: string | undefined) {
    const path = directory ?? await mkdtemp(join(tmpdir(), 'pi-nest-runtime-'))
    await mkdir(path, { mode: 0o700, recursive: true })
    await chmod(path, 0o700)
    return path
  }

  private async getOrCreate(session: PiRuntimeSession) {
    const current = this.entries.get(session.id)
    if (current) {
      clearTimeout(current.idleTimer)
      current.idleTimer = undefined
      return current
    }

    const host = this.createHost(session)
    const entry: RegistryEntry = {
      host,
      idleTimer: undefined,
      unsubscribe: host.onEvent((event) => {
        this.trackExtensionDialog(session.id, event.event)
        void this.streamFor(session.id).stream.publish(event)
      }),
    }
    this.entries.set(session.id, entry)
    return entry
  }

  private scheduleIdleClose(sessionId: string) {
    const entry = this.entries.get(sessionId)
    if (!entry || this.locks.has(sessionId)) return
    clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      if (this.locks.has(sessionId) || this.entries.get(sessionId) !== entry) return
      void this.remove(sessionId)
    }, this.idleTimeoutMs)
    entry.idleTimer.unref()
  }

  private async remove(sessionId: string) {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    clearTimeout(entry.idleTimer)
    this.entries.delete(sessionId)
    this.pendingExtensionDialogs.delete(sessionId)
    entry.unsubscribe()
    await entry.host.close()
    this.scheduleStreamExpiry(sessionId)
  }

  private scheduleStreamExpiry(sessionId: string) {
    const entry = this.streams.get(sessionId)
    if (!entry || this.entries.has(sessionId) || this.locks.has(sessionId) || entry.stream.hasSubscribers) return
    clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      if (this.entries.has(sessionId) || this.locks.has(sessionId) || entry.stream.hasSubscribers || this.streams.get(sessionId) !== entry) return
      this.streams.delete(sessionId)
      this.expiredStreams.add(sessionId)
      void entry.stream.close()
    }, this.eventRetentionMs)
    entry.idleTimer.unref()
  }

  private cancelStreamExpiry(sessionId: string) {
    const entry = this.streams.get(sessionId)
    if (!entry) return
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }

  private streamFor(sessionId: string) {
    let entry = this.streams.get(sessionId)
    if (!entry) {
      entry = { idleTimer: undefined, stream: new SessionEventStream(sessionId, this.eventBufferDirectory) }
      this.streams.set(sessionId, entry)
    }
    this.cancelStreamExpiry(sessionId)
    return entry
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
}
