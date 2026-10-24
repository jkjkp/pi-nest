import type { PiSessionSummary as PublicSessionSummary } from '@pi-nest/contracts'
import { isAbsolute, normalize } from 'node:path'
import type { PiSessionSummary } from '@pi-nest/pi-adapter'

// Match discovered files only; lineage is metadata, never permission to open a path.
export function resolveSessionLineage(sessions: PiSessionSummary[]): (PiSessionSummary & Pick<PublicSessionSummary, 'parentSessionId' | 'parentSessionMissing'>)[] {
  const byPath = new Map(sessions.map((session) => [normalize(session.sessionFile), session]))
  return sessions.map((session) => {
    if (!session.parentSessionPath) return session
    const parent = isAbsolute(session.parentSessionPath) ? byPath.get(normalize(session.parentSessionPath)) : undefined
    return parent && parent.id !== session.id && parent.cwd === session.cwd
      ? { ...session, parentSessionId: parent.id }
      : { ...session, parentSessionMissing: true }
  })
}
