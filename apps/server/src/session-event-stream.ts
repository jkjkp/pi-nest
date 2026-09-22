import { randomUUID } from 'node:crypto'
import { open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { PiRuntimeEvent, PiRuntimeHostEvent } from './pi-runtime-host.js'

export type PiRuntimeStreamError = {
  code: 'EVENT_BUFFER_FAILED'
  message: string
}

export class PiRuntimeResumeError extends Error {
  constructor(readonly code: 'RESUME_AHEAD' | 'RESUME_GAP') {
    super(code === 'RESUME_GAP' ? 'Pi runtime event replay is no longer available' : 'Pi runtime replay sequence is invalid')
  }
}

type Listener = { error: (error: PiRuntimeStreamError) => void; event: (event: PiRuntimeEvent) => void }

/** Per-session ordered event log. It is a transport cache, never a Pi Session source. */
export class SessionEventStream {
  private file: string | undefined
  private firstSequence: number | undefined
  private readonly listeners = new Set<Listener>()
  private queue = Promise.resolve()
  private sequence = 0
  private turnId: string | undefined
  private unavailable = false

  constructor(
    readonly sessionId: string,
    private readonly bufferDirectory: Promise<string>,
  ) {}

  get hasSubscribers() { return this.listeners.size > 0 }

  publish(raw: PiRuntimeHostEvent) {
    return this.serial(async () => {
      if (this.unavailable) return
      const sequence = ++this.sequence
      if (raw.event.type === 'turn_start') this.turnId = `${this.sessionId}:turn:${sequence}`
      const event: PiRuntimeEvent = { ...raw, sequence, ...(this.turnId ? { turnId: this.turnId } : {}) }
      try {
        await this.append(event)
      } catch {
        this.unavailable = true
        for (const listener of this.listeners) listener.error({ code: 'EVENT_BUFFER_FAILED', message: 'Pi runtime event buffer failed' })
        return
      }
      for (const listener of this.listeners) listener.event(event)
      if (raw.event.type === 'turn_end' || raw.event.type === 'agent_settled') this.turnId = undefined
    })
  }

  subscribe(after: number, event: (event: PiRuntimeEvent) => void, error: (error: PiRuntimeStreamError) => void) {
    return this.serial(async () => {
      if (after > this.sequence) throw new PiRuntimeResumeError('RESUME_AHEAD')
      if (this.firstSequence !== undefined && after < this.firstSequence - 1) throw new PiRuntimeResumeError('RESUME_GAP')
      if (this.unavailable) {
        error({ code: 'EVENT_BUFFER_FAILED', message: 'Pi runtime event buffer failed' })
        return () => undefined
      }
      for (const replay of await this.readAfter(after)) event(replay)
      const listener = { error, event }
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    })
  }

  async close() {
    this.listeners.clear()
    if (this.file) await rm(this.file, { force: true })
  }

  private serial<T>(task: () => Promise<T>) {
    const result = this.queue.then(task, task)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async append(event: PiRuntimeEvent) {
    const file = await this.ensureFile()
    const handle = await open(file, 'a', 0o600)
    try {
      await handle.chmod(0o600)
      await handle.write(`${JSON.stringify(event)}\n`)
    } finally {
      await handle.close()
    }
    this.firstSequence ??= event.sequence
  }

  private async ensureFile() {
    if (this.file) return this.file
    this.file = join(await this.bufferDirectory, `${randomUUID()}.jsonl`)
    return this.file
  }

  private async readAfter(after: number) {
    if (!this.file || after === this.sequence) return []
    const contents = await readFile(this.file, 'utf8')
    return contents.trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line) as PiRuntimeEvent).filter((event) => event.sequence > after)
  }
}
