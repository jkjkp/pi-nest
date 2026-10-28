import { capturePiSessionHistory, readPiSessionHistorySourceSignature, samePiSessionHistorySourceSignature, historyFromSnapshot, turnIndexFromSnapshot, type PiSessionHistorySourceSignature, type PiSessionHistorySnapshot, type PiSessionHistoryOptions, type PiSessionSummary } from '@pi-nest/pi-adapter'

type Session = Pick<PiSessionSummary, 'id' | 'cwd' | 'sessionFile'>
type Saved = { binding: string; snapshot: PiSessionHistorySnapshot }
export class HistorySnapshotExpired extends Error {}

/** Disposable read projections of Pi files. Active versions are never evicted. */
export class SessionHistorySnapshots {
  private readonly versions = new Map<string, Saved>()
  private readonly latest = new Map<string, { key: string; signature: PiSessionHistorySourceSignature }>()
  private readonly pinned = new Map<string, string>()
  private readonly runs = new Map<string, { binding: string; before: Set<string> }>()
  private readonly identities = new Map<string, { runId: string; runIndex: number }>()
  private bytes = 0
  constructor(private readonly maxBytes = 128 * 1024 * 1024, private readonly maxVersions = 128) {}

  private binding(session: Session) { return JSON.stringify([session.id, session.cwd, session.sessionFile]) }
  private get(session: Session, revision?: string): PiSessionHistorySnapshot {
    const binding = this.binding(session)
    let key = revision ? `${binding}:${revision}` : this.pinned.get(binding)
    if (!revision && !key) {
      const latest = this.latest.get(binding)
      if (latest && samePiSessionHistorySourceSignature(latest.signature, readPiSessionHistorySourceSignature(session.sessionFile))) key = latest.key
    }
    const saved = key && this.versions.get(key)
    if (saved) {
      this.versions.delete(key!); this.versions.set(key!, saved)
      return saved.snapshot
    }
    const snapshot = capturePiSessionHistory({ sessionFile: session.sessionFile, expectedCwd: session.cwd, expectedSessionId: session.id })
    if (revision && snapshot.revision !== revision) throw new HistorySnapshotExpired('History snapshot expired')
    const nextKey = `${binding}:${snapshot.revision}`
    const existing = this.versions.get(nextKey)
    this.latest.delete(binding)
    if (existing) {
      this.versions.delete(nextKey); this.versions.set(nextKey, existing)
      if (snapshot.sourceSignature) this.latest.set(binding, { key: nextKey, signature: snapshot.sourceSignature })
      return existing.snapshot
    }
    if (snapshot.bytes > this.maxBytes) throw new Error('History snapshot exceeds capacity')
    while (this.bytes + snapshot.bytes > this.maxBytes || this.versions.size >= this.maxVersions) {
      const evict = [...this.versions.keys()].find((candidate) => ![...this.pinned.values()].includes(candidate))
      if (!evict) throw new Error('History snapshot capacity is exhausted')
      this.bytes -= this.versions.get(evict)!.snapshot.bytes
      const removed = this.versions.get(evict)!
      this.versions.delete(evict)
      if (this.latest.get(removed.binding)?.key === evict) this.latest.delete(removed.binding)
      const kept = new Set([...this.versions.values()].filter((saved) => saved.binding === removed.binding).flatMap((saved) => saved.snapshot.entries.map((entry) => entry.id)))
      if (removed.binding === binding) for (const entry of snapshot.entries) kept.add(entry.id)
      for (const entry of removed.snapshot.entries) if (!kept.has(entry.id)) this.identities.delete(`${removed.binding}:${entry.id}`)
    }
    this.versions.set(nextKey, { binding, snapshot }); this.bytes += snapshot.bytes
    if (snapshot.sourceSignature) this.latest.set(binding, { key: nextKey, signature: snapshot.sourceSignature })
    return snapshot
  }

  pin(session: Session, runId: string, currentUser = false) {
    const snapshot = this.get(session)
    const users = snapshot.entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user')
    if (currentUser) {
      const last = users.pop()
      if (last) this.identities.set(`${this.binding(session)}:${last.id}`, { runId, runIndex: 0 })
    }
    this.runs.set(runId, { binding: this.binding(session), before: new Set(users.map((entry) => entry.id)) })
    this.pinned.set(this.binding(session), `${this.binding(session)}:${snapshot.revision}`)
  }
  unpin(session: Session, runId?: string) {
    this.pinned.delete(this.binding(session))
    const run = runId && this.runs.get(runId)
    if (!run || !runId) {
      for (const [id, saved] of this.runs) if (saved.binding === this.binding(session)) this.runs.delete(id)
      return
    }
    try {
      const snapshot = this.get(session)
      const users = snapshot.entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user' && !run.before.has(entry.id))
      users.forEach((entry, runIndex) => this.identities.set(`${run.binding}:${entry.id}`, { runId, runIndex }))
    } finally { this.runs.delete(runId) }
  }
  history(session: Session, options: Pick<PiSessionHistoryOptions, 'revision' | 'before' | 'limit'> = {}) {
    const page = historyFromSnapshot(this.get(session, options.revision), options)
    return { ...page, entries: page.entries.map((entry) => ({ ...entry, ...this.identities.get(`${this.binding(session)}:${entry.id}`) })) }
  }
  index(session: Session, revision?: string) { return turnIndexFromSnapshot(this.get(session, revision)) }
  clear() { this.latest.clear(); this.versions.clear(); this.pinned.clear(); this.runs.clear(); this.identities.clear(); this.bytes = 0 }
}
