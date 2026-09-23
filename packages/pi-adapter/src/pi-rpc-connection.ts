import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export type PiRpcRecord = Record<string, unknown>
export type PiRpcFailureKind = 'process_error' | 'process_exit' | 'protocol_error' | 'rpc_timeout'

export class PiRpcConnectionError extends Error {
  constructor(readonly failureKind: PiRpcFailureKind, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export type PiRpcResponse = PiRpcRecord & {
  command: string
  id?: string
  success: boolean
  type: 'response'
}

export type SpawnRpcProcess = (
  executable: string,
  args: string[],
  options: { cwd: string; stdio: 'pipe' },
) => ChildProcessWithoutNullStreams

export type PiRpcConnectionOptions = {
  args?: string[]
  commandTimeoutMs?: number
  cwd: string
  executable: string
  sessionFile: string
  spawnProcess?: SpawnRpcProcess
  stopTimeoutMs?: number
}

/**
 * A spike-only, lossless JSONL connection to `pi --mode rpc`.
 *
 * This deliberately does not use Pi's RpcClient: the compatibility spike needs
 * every stdout object, including new or unknown event types, before a browser
 * bridge is designed.
 */
export class PiRpcConnection {
  private readonly commandTimeoutMs: number
  private readonly failures = new Set<(error: PiRpcConnectionError) => void>()
  private readonly listeners = new Set<(record: PiRpcRecord) => void>()
  private readonly pending = new Map<
    string,
    { reject: (error: Error) => void; resolve: (response: PiRpcResponse) => void; timer: NodeJS.Timeout }
  >()
  private readonly stopTimeoutMs: number
  private buffer = ''
  private child: ChildProcessWithoutNullStreams | undefined
  private closed = false
  private decoder = new StringDecoder('utf8')
  private nextId = 0
  private processError: Error | undefined
  private stderr = ''

  constructor(private readonly options: PiRpcConnectionOptions) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000
  }

  get stderrText() {
    return this.stderr
  }

  async start() {
    if (this.child) {
      throw new Error('Pi RPC connection is already started')
    }

    const args = this.options.args ?? ['--mode', 'rpc', '--session', this.options.sessionFile]
    const createProcess = this.options.spawnProcess ?? spawn
    const child = createProcess(this.options.executable, args, { cwd: this.options.cwd, stdio: 'pipe' })
    this.child = child

    child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8')
    })
    child.once('error', (cause) => this.fail(new PiRpcConnectionError('process_error', `Pi RPC process error: ${cause.message}`, { cause })))
    child.once('exit', (code, signal) => {
      if (!this.closed) {
        this.fail(new PiRpcConnectionError('process_exit', `Pi RPC process exited before close (code ${code ?? 'null'}, signal ${signal ?? 'null'})`))
      }
    })
  }

  onRecord(listener: (record: PiRpcRecord) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onFailure(listener: (error: PiRpcConnectionError) => void) {
    this.failures.add(listener)
    return () => this.failures.delete(listener)
  }

  async send(command: PiRpcRecord): Promise<PiRpcResponse> {
    const id = typeof command.id === 'string' ? command.id : `pi-nest-rpc-${++this.nextId}`
    const type = command.type
    if (typeof type !== 'string') {
      throw new Error('Pi RPC command requires a string type')
    }

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new PiRpcConnectionError('rpc_timeout', `Pi RPC command timed out: ${type} (${id})`)
        this.fail(error)
        reject(error)
      }, this.commandTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ ...command, id })
      } catch (cause) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  /** Writes an arbitrary protocol record, including extension_ui_response. */
  write(record: PiRpcRecord) {
    if (this.processError) throw this.processError
    if (!this.child || this.closed) {
      throw new Error('Pi RPC connection is not running')
    }
    // JSONL is deliberately LF-only. Do not use platform line endings.
    this.child.stdin.write(`${JSON.stringify(record)}\n`)
  }

  async close() {
    const child = this.child
    if (!child || this.closed) return
    this.closed = true
    child.stdin.end()

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        resolve()
      }, this.stopTimeoutMs)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    this.rejectPending(new Error('Pi RPC connection closed'))
    this.child = undefined
  }

  private consumeStdout(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk)
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const rawLine = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.length > 0) this.handleLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (cause) {
      this.fail(new PiRpcConnectionError('protocol_error', 'Pi RPC stdout contained invalid JSONL', { cause }))
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.fail(new PiRpcConnectionError('protocol_error', 'Pi RPC stdout JSONL values must be objects'))
      return
    }

    const record = parsed as PiRpcRecord
    // Broadcast before handling responses: no type is discarded or rewritten.
    for (const listener of this.listeners) listener(record)
    if (record.type !== 'response' || typeof record.id !== 'string') return

    const pending = this.pending.get(record.id)
    if (!pending) return
    this.pending.delete(record.id)
    clearTimeout(pending.timer)
    if (record.success === true) {
      pending.resolve(record as PiRpcResponse)
    } else {
      pending.reject(new Error(typeof record.error === 'string' ? record.error : 'Pi RPC command failed'))
    }
  }

  private fail(error: PiRpcConnectionError) {
    if (this.processError) return
    this.processError = error
    this.rejectPending(error)
    for (const listener of this.failures) listener(error)
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
