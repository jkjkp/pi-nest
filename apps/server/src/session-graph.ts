import { createHash } from 'node:crypto'
import type { PiSessionHistorySnapshot } from '@pi-nest/pi-adapter'
import type { PiGraphPage, PiGraphTurn } from '@pi-nest/contracts'
import type { BranchRecord } from './session-branch-store.js'

export { graphFamily } from '@pi-nest/contracts/session-graph'

export function graphTurnPage(snapshot: PiSessionHistorySnapshot, relation: BranchRecord | undefined, offset = 0, limit = 100, displayPrompt: (text: string) => string = (text) => text): PiGraphPage {
  const entries: PiGraphTurn[] = []
  const prefix = createHash('sha256')
  const pending = new Set<string>()
  let current: { id: string; promptPreview: string; startedAt: string; hash: ReturnType<typeof createHash>; end: string; position: number; continuation?: string } | undefined
  let inheritedCount = 0
  let inheritedDigest: string | undefined
  const leafPosition = relation?.inherited_leaf_id ? snapshot.entries.findIndex((entry) => entry.id === relation.inherited_leaf_id) : -1
  function finish(beforeCursor?: string) {
    if (!current) return
    const entry: PiGraphTurn = { id: current.id, index: entries.length + 1, promptPreview: current.promptPreview, startedAt: current.startedAt,
      endEntryId: current.end, ...(beforeCursor ? { beforeCursor } : {}), digest: current.hash.digest('hex'), prefixDigest: prefix.copy().digest('hex'), ...(current.continuation ? { continueEntryId: current.continuation } : {}) }
    entries.push(entry)
    if (relation && current.position <= leafPosition) { inheritedCount = entries.length; inheritedDigest = entry.prefixDigest }
  }
  for (const [position, entry] of snapshot.entries.entries()) {
    if (entry.type === 'session_info') continue
    if (entry.type === 'message' && entry.message.role === 'user') {
      finish(entry.id)
      const content = entry.message.content
      const text = typeof content === 'string' ? content : content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      current = { id: entry.id, promptPreview: displayPrompt(text).replace(/\s+/g, ' ').trim().slice(0, 160) || '附件消息', startedAt: entry.timestamp,
        hash: createHash('sha256'), end: entry.id, position }
    }
    const bytes = JSON.stringify(entry) + '\n'
    prefix.update(bytes)
    if (!current) continue
    current.hash.update(bytes); current.end = entry.id; current.position = position
    if (entry.type === 'message') {
      current.continuation = undefined
      if (entry.message.role === 'assistant') {
        for (const block of entry.message.content) if (block.type === 'toolCall') pending.add(block.id)
        if (['stop', 'length'].includes(entry.message.stopReason) && !pending.size) current.continuation = entry.id
      } else if (entry.message.role === 'toolResult') pending.delete(entry.message.toolCallId)
    }
  }
  finish()
  return { revision: snapshot.revision, total: entries.length, entries: entries.slice(offset, offset + limit),
    ...(offset + limit < entries.length ? { nextCursor: String(offset + limit) } : {}), ...(relation ? { inheritedCount, inheritedDigest } : {}) }
}
