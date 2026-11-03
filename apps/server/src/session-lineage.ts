import { branchRelation } from './session-branch-service.js'
import type { BranchRecord } from './session-branch-store.js'
import type { PiSessionSummary as PublicSessionSummary } from '@pi-nest/contracts'
import { isAbsolute, normalize } from 'node:path'
import type { PiSessionSummary } from '@pi-nest/pi-adapter'

// Match discovered files only; lineage is metadata, never permission to open a path.
export function resolveSessionLineage(sessions: PiSessionSummary[], relations = new Map<string, BranchRecord>()): (PiSessionSummary & Pick<PublicSessionSummary, 'parentSessionId' | 'parentSessionMissing' | 'branch'>)[] {
  const byPath = new Map(sessions.map((session) => [normalize(session.sessionFile), session]))
  const native: (PiSessionSummary & Pick<PublicSessionSummary, 'parentSessionId' | 'parentSessionMissing'>)[] = sessions.map((session) => {
    if (!session.parentSessionPath) return session
    const parent = isAbsolute(session.parentSessionPath) ? byPath.get(normalize(session.parentSessionPath)) : undefined
    return parent && parent.id !== session.id && parent.cwd === session.cwd
      ? { ...session, parentSessionId: parent.id }
      : { ...session, parentSessionMissing: true }
  })
  const byId = new Map(native.map((session) => [session.id, session]))
  return native.map((session) => {
    const relation = relations.get(session.id)
    if (!relation) return session
    const branch = branchRelation(relation)
    const parent = byId.get(relation.parent_session_id)
    if (relation.cwd !== session.cwd || parent && parent.cwd !== session.cwd || session.parentSessionId && session.parentSessionId !== relation.parent_session_id) {
      return { ...session, branch: { ...branch, issue: 'conflict' as const } }
    }
    const visited = new Set([session.id])
    let cursor: string | undefined = relation.parent_session_id
    while (cursor) {
      if (visited.has(cursor)) return { ...session, parentSessionId: undefined, parentSessionMissing: true, branch: { ...branch, issue: 'cycle' as const } }
      visited.add(cursor)
      cursor = relations.get(cursor)?.parent_session_id ?? byId.get(cursor)?.parentSessionId
    }
    return { ...session, parentSessionId: parent?.id, parentSessionMissing: !parent, branch: { ...branch, ...(!parent ? { issue: 'missing' as const } : {}) } }
  })
}
