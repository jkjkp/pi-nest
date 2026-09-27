import type { TurnIndexEntry } from './history.js'
import { timelineNavigationEntries, type TimelineItem } from './timeline-model.js'

export type TimelineNavigationTurn = TurnIndexEntry & {
  state: 'persisted' | 'running'
}

function preview(prompt: string | undefined) {
  return prompt?.replace(/\s+/g, ' ').trim().slice(0, 160) || '无用户正文'
}

/**
 * The rail, outline, and body navigation all consume this one ordered projection.
 * Persisted metadata supplies the complete history; loaded live items append only
 * until their persisted user entry replaces them.
 */
export function timelineNavigationTurns(index: TurnIndexEntry[] | undefined, items: TimelineItem[]): TimelineNavigationTurn[] {
  const persisted = index?.map((turn) => ({ ...turn, state: 'persisted' as const })) ?? []
  const known = new Set(persisted.map((turn) => turn.id))
  const nextIndex = persisted.at(-1)?.index ?? 0
  const running: TimelineNavigationTurn[] = []
  for (const item of items) {
    if (known.has(item.id) || !item.prompt?.trim()) continue
    known.add(item.id)
    running.push({ id: item.id, index: nextIndex + running.length + 1, promptPreview: preview(item.prompt), startedAt: item.startedAt, state: 'running' })
  }

  if (persisted.length > 0) return [...persisted, ...running]
  return timelineNavigationEntries(items).map((turn) => ({ id: turn.id, index: turn.index, promptPreview: turn.promptPreview, startedAt: turn.startedAt, state: 'running' as const }))
}
