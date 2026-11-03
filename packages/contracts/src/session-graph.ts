import type { PiSessionSummary } from './index.js'

export function graphFamily(sessions: PiSessionSummary[], selectedId: string) {
  const selected = sessions.find((session) => session.id === selectedId)
  if (!selected) return []
  const candidates = sessions.filter((session) => session.cwd === selected.cwd)
  const adjacent = new Map<string, string[]>()
  for (const session of candidates) {
    const parent = session.parentSessionId ?? (session.branch?.issue !== 'conflict' && session.branch?.issue !== 'cycle' ? session.branch?.parentSessionId : undefined)
    if (!parent) continue
    adjacent.set(session.id, [...(adjacent.get(session.id) ?? []), parent])
    adjacent.set(parent, [...(adjacent.get(parent) ?? []), session.id])
  }
  const seen = new Set([selectedId]); const pending = [selectedId]
  for (let index = 0; index < pending.length; index++) for (const id of adjacent.get(pending[index]) ?? []) if (!seen.has(id)) { seen.add(id); pending.push(id) }
  return candidates.filter((session) => seen.has(session.id))
}
