import { PiRpcConnectionError, PiRpcProcess, type PiRpcFailureKind, type PiRpcProcessState } from '@pi-nest/pi-adapter'

export type PiRuntimeSession = {
  cwd: string
  id: string
  sessionFile: string
}

export type PiRuntimeEvent = {
  event: Record<string, unknown>
  observedAt: string
  sequence: number
  sessionId: string
  turnId?: string
}

/** Raw events reported by the CLI process; transport metadata is assigned by SessionEventStream. */
export type PiRuntimeHostEvent = Omit<PiRuntimeEvent, 'sequence' | 'turnId'>

export type PiRuntimePromptResult = {
  model: { id: string; provider: string } | undefined
  stopReason: string | undefined
}

export type PiRuntimeFailureKind = PiRpcFailureKind | 'rpc_error' | 'startup_timeout'
export type PiRuntimeHostFailure = { kind: PiRuntimeFailureKind; message: string }

export class PiRuntimeHostError extends Error {
  constructor(readonly failure: PiRuntimeHostFailure, options?: ErrorOptions) {
    super(failure.message, options)
  }
}

type RuntimeProcess = Pick<PiRpcProcess, 'close' | 'onEvent' | 'onFailure' | 'send' | 'start' | 'write'>
type ProcessFactory = (session: PiRuntimeSession) => RuntimeProcess

function defaultProcessFactory(session: PiRuntimeSession) {
  return new PiRpcProcess({
    cwd: session.cwd,
    expectedSessionId: session.id,
    sessionFile: session.sessionFile,
  })
}

function stateFrom(response: Record<string, unknown>) {
  const state = response.data
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Pi RPC get_state response did not contain an object')
  }
  return state as Record<string, unknown>
}

function modelFrom(state: Record<string, unknown>) {
  const model = state.model
  if (!model || typeof model !== 'object' || Array.isArray(model)) return undefined
  const candidate = model as Record<string, unknown>
  if (typeof candidate.provider !== 'string' || typeof candidate.id !== 'string') return undefined
  return { id: candidate.id, provider: candidate.provider }
}

function stopReasonFrom(event: Record<string, unknown>) {
  const message = event.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  const candidate = message as Record<string, unknown>
  if (candidate.role !== 'assistant' || typeof candidate.stopReason !== 'string') return undefined
  return candidate.stopReason
}

function failureFrom(cause: unknown): PiRuntimeHostFailure {
  if (cause instanceof PiRuntimeHostError) return cause.failure
  if (cause instanceof PiRpcConnectionError) return { kind: cause.failureKind, message: cause.message }
  if (cause instanceof Error && cause.cause) return failureFrom(cause.cause)
  return { kind: 'rpc_error', message: cause instanceof Error && cause.message ? cause.message : 'Pi RPC command failed' }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PiRuntimeHostError({ kind: 'startup_timeout', message: 'Pi runtime startup timed out' })), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Holds one active native Pi CLI RPC session inside the Server process. */
export class PiRuntimeHost {
  private readonly failureListeners = new Set<(failure: PiRuntimeHostFailure) => void>()
  private readonly listeners = new Set<(event: PiRuntimeHostEvent) => void>()
  private process: RuntimeProcess | undefined
  private processFailureUnsubscribe: (() => void) | undefined
  private processUnsubscribe: (() => void) | undefined
  private startResult: PiRpcProcessState | undefined
  private abortRequested = false
  private running = false
  private started = false

  constructor(
    readonly session: PiRuntimeSession,
    private readonly createProcess: ProcessFactory = defaultProcessFactory,
    private readonly startTimeoutMs = 30_000,
  ) {}

  get isRunning() {
    return this.running
  }

  onEvent(listener: (event: PiRuntimeHostEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onFailure(listener: (failure: PiRuntimeHostFailure) => void) {
    this.failureListeners.add(listener)
    return () => this.failureListeners.delete(listener)
  }

  async start(): Promise<PiRpcProcessState> {
    if (this.started && this.process && this.startResult) return this.startResult

    const process = this.createProcess(this.session)
    this.process = process
    this.processUnsubscribe = process.onEvent((event) => this.publish(event))
    this.processFailureUnsubscribe = process.onFailure((cause) => this.publishFailure(failureFrom(cause)))
    try {
      const state = await withTimeout(process.start(), this.startTimeoutMs)
      this.started = true
      this.startResult = state
      return state
    } catch (cause) {
      await this.close()
      throw new PiRuntimeHostError(failureFrom(cause), { cause })
    }
  }

  async prompt(message: string): Promise<PiRuntimePromptResult> {
    if (this.running) throw new Error('Pi runtime session is already running')
    await this.start()
    const process = this.process
    if (!process) throw new Error('Pi runtime process is unavailable')

    this.running = true
    this.abortRequested = false
    let stopReason: string | undefined
    let settle: (() => void) | undefined
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const unsubscribe = this.onEvent(({ event }) => {
      stopReason ??= stopReasonFrom(event)
      if (event.type === 'agent_settled') settle?.()
    })

    try {
      await process.send({ type: 'prompt', message })
      const state = stateFrom(await process.send({ type: 'get_state' }))
      if (state.isStreaming === true) await settled
      const finalState = stateFrom(await process.send({ type: 'get_state' }))
      return {
        model: modelFrom(finalState),
        stopReason: stopReason ?? (this.abortRequested ? 'aborted' : 'stop'),
      }
    } catch (cause) {
      await this.close()
      throw cause
    } finally {
      unsubscribe()
      this.running = false
    }
  }

  async abort() {
    if (!this.running || !this.process) return false
    this.abortRequested = true
    await this.process.send({ type: 'abort' })
    return true
  }

  async command(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.start()
    if (!this.process) throw new Error('Pi runtime process is unavailable')
    return (await this.process.send(command)) as Record<string, unknown>
  }

  async respondToExtension(response: Record<string, unknown>) {
    await this.start()
    if (!this.process) throw new Error('Pi runtime process is unavailable')
    this.process.write(response)
  }

  async close() {
    this.running = false
    this.started = false
    this.startResult = undefined
    this.processUnsubscribe?.()
    this.processUnsubscribe = undefined
    this.processFailureUnsubscribe?.()
    this.processFailureUnsubscribe = undefined
    const process = this.process
    this.process = undefined
    await process?.close()
  }

  private publish(event: Record<string, unknown>) {
    const envelope: PiRuntimeHostEvent = {
      event,
      observedAt: new Date().toISOString(),
      sessionId: this.session.id,
    }
    for (const listener of this.listeners) listener(envelope)
  }

  private publishFailure(failure: PiRuntimeHostFailure) {
    for (const listener of this.failureListeners) listener(failure)
  }
}
