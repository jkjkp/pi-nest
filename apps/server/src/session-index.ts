import { watch, type FSWatcher } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

import {
  discoverPiSessionFiles,
  mapLimit,
  piSessionsDirectory,
  readPiSessionFileSignature,
  readPiSessionHeader,
  readPiSessionSummary,
  samePiSessionFileIdentity,
  samePiSessionFileSignature,
  SUMMARY_CONCURRENCY,
  type PiSessionBinding,
  type PiSessionDiscovery,
  type PiSessionFileRead,
  type PiSessionFileSignature,
  type PiSessionHeader,
  type PiSessionSummary,
  type PiSessionSummaryRead,
} from '@pi-nest/pi-adapter'

export type { PiSessionBinding, PiSessionSummary } from '@pi-nest/pi-adapter'

const DEFAULT_RECONCILE_INTERVAL_MS = 5_000
const DEFAULT_RECONCILE_WINDOW_MS = 1_000
const WATCH_DEBOUNCE_MS = 200
const STAT_CONCURRENCY = 32
const HEADER_CONCURRENCY = 16

export type PiSessionIndexOptions = {
  directory?: string
  discovery?: (directory: string) => Promise<PiSessionDiscovery>
  readHeader?: (file: string) => Promise<PiSessionFileRead | undefined>
  readSummary?: (file: string) => Promise<PiSessionSummaryRead | undefined>
  stat?: (file: string) => Promise<PiSessionFileSignature | undefined>
  reconcileIntervalMs?: number
  reconcileWindowMs?: number
  watch?: boolean
}

/**
 * Read-side contract shared by every HTTP/WebSocket entry. Implementations only
 * locate native bindings; authorization rechecks stay in each caller.
 */
export interface SessionIndex {
  list(): Promise<PiSessionSummary[]>
  resolve(sessionId: string): Promise<PiSessionBinding | undefined>
  hasWorkspace(cwd: string): Promise<boolean>
  cachedSummary(sessionId: string): PiSessionSummary | undefined
  register(binding: PiSessionBinding, summary?: PiSessionSummary): void
  invalidate(sessionIdOrFile: string): void
  forget(sessionIdOrFile: string): void
  close(): void
}

type BindingState = {
  binding: PiSessionBinding
  header: PiSessionHeader | undefined
  signature: PiSessionFileSignature | undefined
  summary: PiSessionSummary | undefined
  summarySignature: PiSessionFileSignature | undefined
  stale: boolean
  version: number
  headerRead?: Promise<PiSessionFileRead | undefined>
  summaryRead?: Promise<void>
}

type RequiredOptions = {
  reconcileIntervalMs: number
  reconcileWindowMs: number
  watch: boolean
}

function updatedAtTime(summary: PiSessionSummary) {
  const time = summary.updatedAt ? Date.parse(summary.updatedAt) : Number.NaN
  return Number.isNaN(time) ? 0 : time
}

function isoTime(value: string | undefined) {
  if (!value) return undefined
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

/**
 * Process-wide projection of native Pi session files.
 *
 * - Bindings (id/cwd/file) come from file headers only.
 * - Summaries are cached per file and invalidated by the file signature.
 * - Watchers invalidate immediately; a 5s metadata scan recovers lost events.
 * - Directory reconciliation and per-file body reads are shared between callers.
 */
export class PiSessionIndex implements SessionIndex {
  private readonly options: RequiredOptions
  private readonly discovery: (directory: string) => Promise<PiSessionDiscovery>
  private readonly readHeaderFile: (file: string) => Promise<PiSessionFileRead | undefined>
  private readonly readSummaryFile: (file: string) => Promise<PiSessionSummaryRead | undefined>
  private readonly statFile: (file: string) => Promise<PiSessionFileSignature | undefined>
  private readonly explicitDirectory: string | undefined

  private readonly byId = new Map<string, BindingState>()
  private readonly byFile = new Map<string, BindingState>()
  private readonly workspaceCounts = new Map<string, number>()

  private resolvedDirectory: string | undefined
  private reconciliation: Promise<void> | undefined
  private lastReconciledAt = 0
  private dirty = true
  private started = false
  private closed = false
  private watcher: FSWatcher | undefined
  private interval: NodeJS.Timeout | undefined
  private debounce: NodeJS.Timeout | undefined

  constructor(options: PiSessionIndexOptions = {}) {
    this.explicitDirectory = options.directory
    this.discovery = options.discovery ?? ((directory) => discoverPiSessionFiles(directory))
    this.readHeaderFile = options.readHeader ?? ((file) => readPiSessionHeader(file))
    this.readSummaryFile = options.readSummary ?? ((file) => readPiSessionSummary(file))
    this.statFile = options.stat ?? ((file) => readPiSessionFileSignature(file))
    this.options = {
      reconcileIntervalMs: options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
      reconcileWindowMs: options.reconcileWindowMs ?? DEFAULT_RECONCILE_WINDOW_MS,
      watch: options.watch ?? true,
    }
  }

  private get directory() {
    this.resolvedDirectory ??= this.explicitDirectory ?? piSessionsDirectory()
    return this.resolvedDirectory
  }

  private ensureStarted() {
    if (this.started || this.closed) return
    this.started = true
    this.openWatcher()
    if (this.options.reconcileIntervalMs > 0) {
      this.interval = setInterval(() => { void this.ensureReconciled().catch(() => undefined) }, this.options.reconcileIntervalMs)
      this.interval.unref()
    }
  }

  private openWatcher() {
    if (!this.options.watch || this.closed || this.watcher) return
    try {
      const watcher = watch(this.directory, { recursive: true }, (event, filename) => this.onWatch(event, filename))
      watcher.on('error', () => {
        this.markDirty()
        if (this.watcher === watcher) this.watcher = undefined
        watcher.close()
      })
      watcher.unref()
      this.watcher = watcher
    } catch {
      // A missing directory or unsupported recursive watch falls back to polling.
    }
  }

  private onWatch(event: 'rename' | 'change', filename: string | Buffer | null) {
    if (this.closed) return
    if (!filename) {
      this.markDirty()
      return
    }
    const relative = filename.toString()
    const file = resolvePath(this.directory, relative)
    if (!relative.endsWith('.jsonl')) {
      this.markDirty()
      return
    }
    const state = this.byFile.get(file)
    if (state && event === 'change') {
      state.stale = true
      return
    }
    this.markDirty()
  }

  private markDirty() {
    this.dirty = true
    if (this.debounce || this.closed) return
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      void this.ensureReconciled().catch(() => undefined)
    }, WATCH_DEBOUNCE_MS)
    this.debounce.unref()
  }

  private ensureReconciled(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.ensureStarted()
    if (this.reconciliation) return this.reconciliation
    if (!this.dirty && Date.now() - this.lastReconciledAt < this.options.reconcileWindowMs) return Promise.resolve()
    this.dirty = false
    const scan = this.reconcile()
    this.reconciliation = scan
    void scan
      .catch(() => { this.dirty = true })
      .finally(() => {
        if (this.reconciliation === scan) this.reconciliation = undefined
        this.lastReconciledAt = Date.now()
      })
    return scan
  }

  private async reconcile(): Promise<void> {
    try {
      // Bindings present before the scan; anything registered while it runs is left to the next pass.
      const previousBindings = new Map(this.byFile)
      this.openWatcher()
      const discovery = await this.discovery(this.directory)
      const files = [...new Set(discovery.files)]
      const listed = new Set(files)
      const signatures = new Map<string, PiSessionFileSignature | undefined>()
      await mapLimit(files, STAT_CONCURRENCY, async (file) => {
        signatures.set(file, await this.statFile(file))
      })

      if (discovery.complete) {
        for (const [file, state] of previousBindings) {
          if (this.byFile.get(file) !== state) continue
          if (!listed.has(file) || !signatures.get(file)) this.removeBinding(state)
        }
      }

      const needHeader: string[] = []
      for (const file of files) {
        const signature = signatures.get(file)
        if (!signature) continue
        const state = this.byFile.get(file)
        if (!state) {
          needHeader.push(file)
          continue
        }
        if (!state.signature) {
          state.signature = signature
          continue
        }
        if (samePiSessionFileSignature(state.signature, signature)) continue
        const previous = state.signature
        state.signature = signature
        state.stale = true
        // Appends only invalidate the summary; replacements and truncations re-read the header.
        if (!samePiSessionFileIdentity(previous, signature) || signature.size < previous.size) {
          state.version += 1
          needHeader.push(file)
        }
      }

      await mapLimit(needHeader, HEADER_CONCURRENCY, (file) => this.refreshBinding(file))
    } catch {
      this.dirty = true
    }
  }

  private async refreshBinding(file: string) {
    const read = await this.readHeaderFile(file)
    if (!read) {
      const existing = this.byFile.get(file)
      if (existing) this.removeBinding(existing)
      return
    }
    const existing = this.byFile.get(file)
    if (existing) {
      if (read.header.id !== existing.binding.id || (read.header.cwd || undefined) !== existing.binding.cwd) {
        this.removeBinding(existing)
      } else {
        existing.header = read.header
        existing.signature = read.signature
        existing.stale = true
        return
      }
    }
    this.addBinding(read.header, read.signature, file)
  }

  private addBinding(header: PiSessionHeader, signature: PiSessionFileSignature | undefined, file: string) {
    const state: BindingState = {
      binding: { cwd: header.cwd || undefined, id: header.id, sessionFile: file },
      header,
      signature,
      summary: undefined,
      summarySignature: undefined,
      stale: true,
      version: 0,
    }
    this.byFile.set(file, state)
    this.claimId(state)
    this.countWorkspace(state.binding.cwd, 1)
    return state
  }

  private claimId(state: BindingState) {
    const current = this.byId.get(state.binding.id)
    if (!current || current === state) {
      this.byId.set(state.binding.id, state)
      return
    }
    // Duplicate IDs are pathological; resolve prefers the newest file.
    if ((state.signature?.mtimeMs ?? 0) > (current.signature?.mtimeMs ?? 0)) this.byId.set(state.binding.id, state)
  }

  private removeBinding(state: BindingState) {
    if (this.byFile.get(state.binding.sessionFile) !== state) return
    this.byFile.delete(state.binding.sessionFile)
    this.countWorkspace(state.binding.cwd, -1)
    if (this.byId.get(state.binding.id) !== state) return
    this.byId.delete(state.binding.id)
    let replacement: BindingState | undefined
    for (const candidate of this.byFile.values()) {
      if (candidate.binding.id !== state.binding.id) continue
      if (!replacement || (candidate.signature?.mtimeMs ?? 0) > (replacement.signature?.mtimeMs ?? 0)) replacement = candidate
    }
    if (replacement) this.byId.set(state.binding.id, replacement)
  }

  private countWorkspace(cwd: string | undefined, delta: number) {
    if (!cwd) return
    const count = (this.workspaceCounts.get(cwd) ?? 0) + delta
    if (count > 0) this.workspaceCounts.set(cwd, count)
    else this.workspaceCounts.delete(cwd)
  }

  private find(value: string) {
    return this.byFile.get(value) ?? this.byId.get(value)
  }

  private async verifyHeader(state: BindingState): Promise<PiSessionFileRead | undefined> {
    state.headerRead ??= this.readHeaderFile(state.binding.sessionFile).finally(() => {
      state.headerRead = undefined
    })

    let read: PiSessionFileRead | undefined
    try {
      read = await state.headerRead
    } catch {
      read = undefined
    }
    if (!read) {
      this.removeBinding(state)
      this.markDirty()
      return undefined
    }
    if (this.byFile.get(state.binding.sessionFile) !== state) return undefined
    if (read.header.id !== state.binding.id || (read.header.cwd || undefined) !== state.binding.cwd) {
      this.removeBinding(state)
      this.markDirty()
      return undefined
    }
    if (state.signature && !samePiSessionFileIdentity(state.signature, read.signature)) {
      // Same path, different file: never authorize the cached binding.
      this.removeBinding(state)
      this.markDirty()
      return undefined
    }
    const previous = state.signature
    state.header = read.header
    state.signature = read.signature
    if (previous && !samePiSessionFileSignature(previous, read.signature)) state.stale = true
    return read
  }

  private needsSummary(state: BindingState) {
    if (this.byFile.get(state.binding.sessionFile) !== state) return false
    if (state.stale || !state.summary || !state.summarySignature) return true
    return state.signature !== undefined && !samePiSessionFileSignature(state.summarySignature, state.signature)
  }

  private async loadSummary(state: BindingState) {
    if (state.summaryRead) return state.summaryRead
    const path = state.binding.sessionFile
    const version = state.version

    const read = (async () => {
      const result = await this.readSummaryFile(path)
      if (this.byFile.get(path) !== state) return
      if (!result) {
        state.stale = true
        this.markDirty()
        return
      }
      if (state.version !== version) return
      if (result.header.id !== state.binding.id || (result.header.cwd || undefined) !== state.binding.cwd) {
        this.removeBinding(state)
        this.markDirty()
        return
      }
      // Publish only if the file still matches the exact bytes that were read.
      const current = await this.statFile(path)
      if (!current || !samePiSessionFileSignature(current, result.signature)) {
        state.stale = true
        if (current) state.signature = current
        if (!current) this.markDirty()
        return
      }
      state.header = result.header
      state.signature = result.signature
      state.summary = result.summary
      state.summarySignature = result.signature
      state.stale = false
    })().catch(() => {
      state.stale = true
    })

    state.summaryRead = read
    try {
      await read
    } finally {
      if (state.summaryRead === read) state.summaryRead = undefined
    }
  }

  private summaryFor(state: BindingState) {
    const summary = state.summary
    if (summary && summary.id === state.binding.id && (summary.cwd || undefined) === state.binding.cwd) return summary
    const createdAt = isoTime(state.header?.timestamp)
    return {
      id: state.binding.id,
      cwd: state.binding.cwd,
      sessionFile: state.binding.sessionFile,
      name: undefined,
      firstMessage: undefined,
      createdAt,
      updatedAt: createdAt,
      parentSessionPath: state.header?.parentSessionPath,
    } satisfies PiSessionSummary
  }

  async resolve(sessionId: string): Promise<PiSessionBinding | undefined> {
    await this.ensureReconciled()
    const state = this.byId.get(sessionId)
    if (!state) return undefined
    const verified = await this.verifyHeader(state)
    return verified ? { ...state.binding } : undefined
  }

  async hasWorkspace(cwd: string): Promise<boolean> {
    await this.ensureReconciled()
    if (!this.workspaceCounts.has(cwd)) return false
    // Counts only narrow the candidates; authorization still requires one live header binding.
    for (const state of this.byFile.values()) {
      if (state.binding.cwd !== cwd) continue
      if (await this.verifyHeader(state)) return true
    }
    return false
  }

  cachedSummary(sessionId: string) {
    const state = this.byId.get(sessionId)
    const summary = state?.summary
    if (!state || !summary) return undefined
    return summary.id === state.binding.id && (summary.cwd || undefined) === state.binding.cwd ? summary : undefined
  }

  async list(): Promise<PiSessionSummary[]> {
    await this.ensureReconciled()
    const states = [...this.byFile.values()]
    await mapLimit(states, SUMMARY_CONCURRENCY, async (state) => {
      if (this.needsSummary(state)) await this.loadSummary(state)
    })
    return states
      .filter((state) => this.byFile.get(state.binding.sessionFile) === state)
      .map((state) => this.summaryFor(state))
      .sort((left, right) => updatedAtTime(right) - updatedAtTime(left))
  }

  register(binding: PiSessionBinding, summary?: PiSessionSummary) {
    if (this.closed) return
    const existing = this.byFile.get(binding.sessionFile)
    if (existing) this.removeBinding(existing)
    const state = this.addBinding({ id: binding.id, ...(binding.cwd ? { cwd: binding.cwd } : {}) }, undefined, binding.sessionFile)
    if (summary) state.summary = summary
    state.stale = true
  }

  invalidate(sessionIdOrFile: string) {
    const state = this.find(sessionIdOrFile)
    if (!state) {
      this.markDirty()
      return
    }
    state.version += 1
    state.stale = true
    state.summarySignature = undefined
  }

  forget(sessionIdOrFile: string) {
    const state = this.find(sessionIdOrFile)
    if (state) this.removeBinding(state)
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.interval) clearInterval(this.interval)
    if (this.debounce) clearTimeout(this.debounce)
    this.interval = undefined
    this.debounce = undefined
    this.watcher?.close()
    this.watcher = undefined
  }
}
