export type PiRuntimeEvent = {
  event: Record<string, unknown>
  observedAt: string
  sequence: number
  sessionId: string
  turnId?: string
}

export type RuntimeError = { code: string; id?: string; message: string; sessionId?: string; type: 'error' }
type RuntimeAck = { command: string; data?: unknown; id: string; sessionId: string; type: 'ack' }
type RuntimeMessage = RuntimeAck | RuntimeError | ({ type: 'pi_event' } & PiRuntimeEvent)
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

/** One browser-owned WebSocket with ordered per-session replay after disconnects. */
export class RuntimeWebSocketClient {
  private readonly attached = new Map<string, number>()
  private connectPromise: Promise<RuntimeSocket> | undefined
  private readonly errors = new Set<(error: RuntimeError) => void>()
  private nextId = 0
  private readonly pending = new Map<string, PendingCommand>()
  private readonly piEvents = new Set<(event: PiRuntimeEvent) => void>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private readonly recovering = new Set<string>()
  private runtimeId: string | undefined
  private socket: RuntimeSocket | undefined
  private readonly options: RuntimeWebSocketClientOptions

  constructor(options: RuntimeWebSocketClientOptions = {}) {
    this.options = options
  }

  onError(listener: (error: RuntimeError) => void) {
    this.errors.add(listener)
    return () => { this.errors.delete(listener) }
  }

  onPiEvent(listener: (event: PiRuntimeEvent) => void) {
    this.piEvents.add(listener)
    return () => { this.piEvents.delete(listener) }
  }

  attach(sessionId: string, after = 0) {
    // Never move the cursor backwards: callers re-attach before every prompt, and a lower
    // cursor would make every following event look out of order.
    this.attached.set(sessionId, Math.max(this.attached.get(sessionId) ?? 0, after))
    return this.command('attach', sessionId, undefined, after)
  }

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
        for (const sessionId of this.attached.keys()) this.notify({ code: 'RUNTIME_RESTARTED', message: 'Pi runtime server restarted', sessionId, type: 'error' })
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
    if (message.type === 'ack') {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      pending?.resolve(message.data)
      return
    }
    const pending = message.id ? this.pending.get(message.id) : undefined
    if (message.id) this.pending.delete(message.id)
    pending?.reject(new Error(message.message))
    this.notify(message)
  }

  private handleEvent(message: { type: 'pi_event' } & PiRuntimeEvent) {
    const last = this.attached.get(message.sessionId)
    if (last === undefined || !Number.isInteger(message.sequence) || message.sequence < 1) return
    if (message.sequence <= last) return
    if (message.sequence !== last + 1) {
      this.resume(message.sessionId, last)
      return
    }
    this.attached.set(message.sessionId, message.sequence)
    const { type: _type, ...event } = message
    for (const listener of this.piEvents) listener(event)
  }

  private handleClose(socket: RuntimeSocket) {
    if (this.socket !== socket) return
    this.socket = undefined
    for (const pending of this.pending.values()) pending.reject(new RuntimeConnectionError('Pi runtime connection closed'))
    this.pending.clear()
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.attached.size === 0 || this.reconnectTimer) return
    const delay = (this.options.reconnectDelay ?? reconnectDelay)(this.reconnectAttempt++)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.reconnect()
    }, delay)
  }

  private async reconnect() {
    try {
      await this.connect()
      await Promise.all([...this.attached].map(([sessionId, after]) => this.command('attach', sessionId, undefined, after)))
      this.reconnectAttempt = 0
    } catch {
      this.scheduleReconnect()
    }
  }

  private resume(sessionId: string, after: number) {
    if (this.recovering.has(sessionId)) return
    this.recovering.add(sessionId)
    void this.command('attach', sessionId, undefined, after)
      .catch(() => undefined)
      .finally(() => this.recovering.delete(sessionId))
  }

  private notify(error: RuntimeError) {
    for (const listener of this.errors) listener(error)
  }
}
