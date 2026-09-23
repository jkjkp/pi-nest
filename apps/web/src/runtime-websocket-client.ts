export type PiRuntimeEvent = {
  event: Record<string, unknown>
  observedAt: string
  sequence: number
  sessionId: string
  turnId?: string
}

export type RuntimeError = { code: string; id?: string; message: string; sessionId?: string; type: 'error' }
export type RuntimeLifecycle = 'notLoaded' | 'loading' | 'idle' | 'active' | 'failed'
export type RuntimeStatus = { error?: string; lifecycle: RuntimeLifecycle; revision: number; sessionId: string }
export type SessionSnapshot = {
  atSequence: number
  extensionUi: { freshness: 'known' | 'unknown'; statuses: Record<string, string>; widgets: Record<string, string[]> }
  runtime: Omit<RuntimeStatus, 'sessionId'>
  sessionId: string
}
type RuntimeAck = { command: string; data?: unknown; id: string; sessionId: string; type: 'ack' }
type RuntimeMessage = RuntimeAck | RuntimeError | ({ type: 'pi_event' } & PiRuntimeEvent) | ({ type: 'session_snapshot' } & SessionSnapshot) | ({ type: 'runtime_status' } & RuntimeStatus)
type RuntimeSocket = Pick<WebSocket, 'close' | 'readyState' | 'send'> & { addEventListener: WebSocket['addEventListener'] }

type RuntimeWebSocketClientOptions = {
  fetchFn?: typeof fetch
  reconnectDelay?: (attempt: number) => number
  socketFactory?: (url: string) => RuntimeSocket
}

type PendingCommand = { reject: (cause: Error) => void; resolve: (data: unknown) => void }

export type PiRuntimeState = {
  followUpMode?: string
  isCompacting: boolean
  isStreaming: boolean
  model?: { id?: string; provider?: string }
  steeringMode?: string
  thinkingLevel?: string
}
export type PiRuntimeModel = { id: string; name?: string; provider: string }

const runtimeIdStorageKey = 'pi-nest-runtime-instance'
const watchStorageKey = 'pi-nest-runtime-watches'
export type WatchRole = 'background' | 'foreground'
type Watch = { after: number; role: WatchRole }

export class RuntimeConnectionError extends Error {}

export function isRuntimeConnectionError(cause: unknown) {
  return cause instanceof RuntimeConnectionError
}

function runtimeUrl(path: string, token: string) {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  return url.toString()
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : 'Pi runtime connection failed'
}

function reconnectDelay(attempt: number) {
  return Math.min(5_000, 250 * 2 ** Math.min(attempt, 4))
}

function savedRuntimeId() {
  if (typeof window === 'undefined') return undefined
  try {
    return window.sessionStorage?.getItem(runtimeIdStorageKey) ?? undefined
  } catch {
    return undefined
  }
}

function saveRuntimeId(runtimeId: string) {
  try {
    if (typeof window !== 'undefined') window.sessionStorage?.setItem(runtimeIdStorageKey, runtimeId)
  } catch {
    // sessionStorage is only a recovery hint; runtime delivery must continue without it.
  }
}

function savedWatches(): Array<[string, Watch]> {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(window.sessionStorage?.getItem(watchStorageKey) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    return Object.entries(value).flatMap(([sessionId, watch]) => {
      if (!watch || typeof watch !== 'object' || Array.isArray(watch)) return []
      const value = watch as Record<string, unknown>
      return typeof value.after === 'number' && Number.isInteger(value.after) && (value.role === 'foreground' || value.role === 'background') ? [[sessionId, { after: value.after, role: value.role }]] : []
    })
  } catch {
    return []
  }
}

/** One browser-owned WebSocket with ordered per-session replay after disconnects. */
export class RuntimeWebSocketClient {
  private readonly watched = new Map<string, Watch>()
  private connectPromise: Promise<RuntimeSocket> | undefined
  private readonly errors = new Set<(error: RuntimeError) => void>()
  private nextId = 0
  private readonly pending = new Map<string, PendingCommand>()
  private readonly piEvents = new Set<(event: PiRuntimeEvent) => void>()
  private readonly projectionFloors = new Map<string, number>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private readonly recovering = new Set<string>()
  private readonly runtimeStatuses = new Set<(status: RuntimeStatus) => void>()
  private readonly runtimeStates = new Map<string, RuntimeStatus>()
  private readonly sessionSnapshots = new Set<(snapshot: SessionSnapshot) => void>()
  private readonly uiFreshness = new Map<string, 'known' | 'unknown'>()
  private runtimeId: string | undefined
  private socket: RuntimeSocket | undefined
  private readonly options: RuntimeWebSocketClientOptions

  constructor(options: RuntimeWebSocketClientOptions = {}) {
    this.options = options
    for (const [sessionId, watch] of savedWatches()) this.watched.set(sessionId, watch)
  }

  onError(listener: (error: RuntimeError) => void) {
    this.errors.add(listener)
    return () => { this.errors.delete(listener) }
  }

  onPiEvent(listener: (event: PiRuntimeEvent) => void) {
    this.piEvents.add(listener)
    return () => { this.piEvents.delete(listener) }
  }

  onSessionSnapshot(listener: (snapshot: SessionSnapshot) => void) {
    this.sessionSnapshots.add(listener)
    return () => { this.sessionSnapshots.delete(listener) }
  }

  onRuntimeStatus(listener: (status: RuntimeStatus) => void) {
    this.runtimeStatuses.add(listener)
    return () => { this.runtimeStatuses.delete(listener) }
  }

  extensionUiFreshness(sessionId: string) {
    return this.uiFreshness.get(sessionId)
  }

  shouldApplyExtensionUi(event: PiRuntimeEvent) {
    return event.sequence > (this.projectionFloors.get(event.sessionId) ?? 0)
  }

  watchedSessions() {
    return [...this.watched].map(([sessionId, watch]) => ({ sessionId, ...watch }))
  }

  watch(sessionId: string, role: WatchRole = 'foreground', after = this.watched.get(sessionId)?.after ?? 0) {
    this.watched.set(sessionId, { after, role })
    this.saveWatches()
    return this.sendWatch(sessionId, after)
  }

  async unwatch(sessionId: string) {
    if (!this.watched.has(sessionId)) return
    this.watched.delete(sessionId)
    this.saveWatches()
    await this.command('unwatch', sessionId)
  }

  resumeRuntime(sessionId: string) { return this.command('resume', sessionId) }

  prompt(sessionId: string, message: string) { return this.command('prompt', sessionId, message) }
  abort(sessionId: string) { return this.command('abort', sessionId) }
  steer(sessionId: string, message: string) { return this.command('steer', sessionId, message) }
  followUp(sessionId: string, message: string) { return this.command('follow_up', sessionId, message) }
  setModel(sessionId: string, provider: string, modelId: string) { return this.command('set_model', sessionId, undefined, undefined, { modelId, provider }) }
  setThinkingLevel(sessionId: string, level: string) { return this.command('set_thinking_level', sessionId, undefined, undefined, { level }) }
  compact(sessionId: string) { return this.command('compact', sessionId) }
  getRuntimeState(sessionId: string) { return this.command<PiRuntimeState>('get_runtime_state', sessionId) }
  getAvailableModels(sessionId: string) { return this.command<{ models: PiRuntimeModel[] }>('get_available_models', sessionId) }
  getAvailableThinkingLevels(sessionId: string) { return this.command<{ levels: string[] }>('get_available_thinking_levels', sessionId) }
  extensionUiResponse(sessionId: string, dialogId: string, response: { cancelled?: boolean; confirmed?: boolean; value?: unknown }) {
    return this.command('extension_ui_response', sessionId, undefined, undefined, { ...response, dialogId })
  }

  private async command<T = void>(type: string, sessionId: string, message?: string, after?: number, extra?: Record<string, unknown>): Promise<T> {
    const socket = await this.connect()
    const id = `web-${++this.nextId}`
    const result = new Promise<T>((resolve, reject) => this.pending.set(id, { reject, resolve: (data) => resolve(data as T) }))
    socket.send(JSON.stringify({ ...extra, id, ...(message === undefined ? {} : { message }), ...(after === undefined ? {} : { resume: { after } }), sessionId, type }))
    return result
  }

  private async connect() {
    if (this.socket?.readyState === 1) return this.socket
    this.connectPromise ??= this.open()
    try {
      return await this.connectPromise
    } catch (cause) {
      this.scheduleReconnect()
      throw cause
    } finally {
      this.connectPromise = undefined
    }
  }

  private async open() {
    try {
      const response = await (this.options.fetchFn ?? fetch)('/api/runtime/bootstrap', { method: 'POST' })
      if (!response.ok) throw new Error('Pi runtime bootstrap failed')
      const bootstrap = await response.json() as { runtimeId?: unknown; token?: unknown; websocketPath?: unknown }
      if (typeof bootstrap.runtimeId !== 'string' || typeof bootstrap.token !== 'string' || typeof bootstrap.websocketPath !== 'string') throw new Error('Pi runtime bootstrap was invalid')
      const previousRuntimeId = this.runtimeId ?? savedRuntimeId()
      const changedRuntime = previousRuntimeId !== undefined && previousRuntimeId !== bootstrap.runtimeId
      this.runtimeId = bootstrap.runtimeId
      saveRuntimeId(bootstrap.runtimeId)

      const socket = (this.options.socketFactory ?? ((url) => new WebSocket(url)))(runtimeUrl(bootstrap.websocketPath, bootstrap.token))
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true })
        socket.addEventListener('error', () => reject(new RuntimeConnectionError('Pi runtime connection failed')), { once: true })
      })
      this.socket = socket
      socket.addEventListener('message', (event) => this.handleMessage(event.data))
      socket.addEventListener('close', () => this.handleClose(socket))
      if (changedRuntime) {
        for (const [sessionId, watch] of this.watched) {
          watch.after = 0
          this.notify({ code: 'RUNTIME_RESTARTED', message: 'Pi runtime server restarted', sessionId, type: 'error' })
        }
        this.saveWatches()
      }
      return socket
    } catch (cause) {
      throw cause instanceof RuntimeConnectionError ? cause : new RuntimeConnectionError(errorMessage(cause))
    }
  }

  private handleMessage(data: unknown) {
    if (typeof data !== 'string') return
    let message: RuntimeMessage
    try {
      message = JSON.parse(data) as RuntimeMessage
    } catch {
      return
    }
    if (message.type === 'pi_event') return this.handleEvent(message)
    if (message.type === 'session_snapshot') return this.handleSnapshot(message)
    if (message.type === 'runtime_status') return this.handleRuntimeStatus(message)
    if (message.type === 'ack') {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      pending?.resolve(message.data)
      return
    }
    const pending = message.id ? this.pending.get(message.id) : undefined
    if (message.id) this.pending.delete(message.id)
    pending?.reject(Object.assign(new Error(message.message), { code: message.code }))
    this.notify(message)
  }

  private handleEvent(message: { type: 'pi_event' } & PiRuntimeEvent) {
    const watch = this.watched.get(message.sessionId)
    if (!watch || !Number.isInteger(message.sequence) || message.sequence < 1) return
    if (message.sequence <= watch.after) return
    if (message.sequence !== watch.after + 1) {
      this.recoverWatch(message.sessionId, watch.after)
      return
    }
    watch.after = message.sequence
    this.saveWatches()
    const { type: _type, ...event } = message
    for (const listener of this.piEvents) listener(event)
  }

  private handleSnapshot(message: { type: 'session_snapshot' } & SessionSnapshot) {
    if (!Number.isInteger(message.atSequence) || message.atSequence < 0) return
    this.projectionFloors.set(message.sessionId, message.atSequence)
    this.uiFreshness.set(message.sessionId, message.extensionUi.freshness)
    const snapshot: SessionSnapshot = {
      atSequence: message.atSequence,
      extensionUi: {
        freshness: message.extensionUi.freshness,
        statuses: { ...message.extensionUi.statuses },
        widgets: Object.fromEntries(Object.entries(message.extensionUi.widgets).map(([key, lines]) => [key, [...lines]])),
      },
      runtime: { ...message.runtime },
      sessionId: message.sessionId,
    }
    for (const listener of this.sessionSnapshots) listener(snapshot)
    this.applyRuntimeStatus({ ...snapshot.runtime, sessionId: snapshot.sessionId })
  }

  private handleRuntimeStatus(message: { type: 'runtime_status' } & RuntimeStatus) {
    this.applyRuntimeStatus({ ...(message.error ? { error: message.error } : {}), lifecycle: message.lifecycle, revision: message.revision, sessionId: message.sessionId })
  }

  private applyRuntimeStatus(status: RuntimeStatus) {
    if (!Number.isInteger(status.revision) || status.revision < 0) return
    const current = this.runtimeStates.get(status.sessionId)
    if (current && status.revision <= current.revision) return
    this.runtimeStates.set(status.sessionId, status)
    for (const listener of this.runtimeStatuses) listener(status)
  }

  private handleClose(socket: RuntimeSocket) {
    if (this.socket !== socket) return
    this.socket = undefined
    for (const pending of this.pending.values()) pending.reject(new RuntimeConnectionError('Pi runtime connection closed'))
    this.pending.clear()
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.watched.size === 0 || this.reconnectTimer) return
    const delay = (this.options.reconnectDelay ?? reconnectDelay)(this.reconnectAttempt++)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.reconnect()
    }, delay)
  }

  private async reconnect() {
    try {
      await this.connect()
      await Promise.all([...this.watched].map(([sessionId, watch]) => this.sendWatch(sessionId, watch.after)))
      this.reconnectAttempt = 0
    } catch {
      this.scheduleReconnect()
    }
  }

  private async sendWatch(sessionId: string, after: number) {
    try {
      await this.command('watch', sessionId, undefined, after)
    } catch (cause) {
      if ((cause as { code?: unknown }).code !== 'RESUME_GAP' || after === 0) throw cause
      const watch = this.watched.get(sessionId)
      if (!watch) return
      watch.after = 0
      this.saveWatches()
      await this.command('watch', sessionId, undefined, 0)
    }
  }

  private recoverWatch(sessionId: string, after: number) {
    if (this.recovering.has(sessionId)) return
    this.recovering.add(sessionId)
    void this.sendWatch(sessionId, after)
      .catch(() => undefined)
      .finally(() => this.recovering.delete(sessionId))
  }

  private saveWatches() {
    try {
      if (typeof window !== 'undefined') window.sessionStorage.setItem(watchStorageKey, JSON.stringify(Object.fromEntries(this.watched)))
    } catch {
      // sessionStorage is only a recovery hint.
    }
  }

  private notify(error: RuntimeError) {
    for (const listener of this.errors) listener(error)
  }
}
