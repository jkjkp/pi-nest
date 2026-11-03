import { expect, it } from 'vitest'
import { graphTurnPage, graphFamily } from './session-graph.js'
import type { PiSessionHistorySnapshot } from '@pi-nest/pi-adapter'
const timestamp = new Date().toISOString()
const user = (id: string, parentId: string | null, text = id) => ({ id, parentId, type: 'message', timestamp, message: { role: 'user', content: text, timestamp: 0 } })
const answer = { id: 'answer', parentId: 'a', type: 'message', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }], stopReason: 'stop', timestamp: 0 } }
it('paginates stable native turns and includes only valid continuation boundaries', () => {
  const snapshot = { entries: [user('a', null), answer, user('b', 'answer')], revision: 'r1', bytes: 1 } as PiSessionHistorySnapshot
  const first = graphTurnPage(snapshot, undefined, 0, 1)
  expect(first.entries[0]).toMatchObject({ id: 'a', endEntryId: 'answer', continueEntryId: 'answer' })
  expect(first.nextCursor).toBe('1')
  expect(graphTurnPage(snapshot, undefined, 1, 1).entries[0].continueEntryId).toBeUndefined()
  expect(first.entries[0].digest).not.toBe(graphTurnPage({ ...snapshot, entries: [user('a', null, 'changed'), answer] } as PiSessionHistorySnapshot, undefined, 0, 1).entries[0].digest)
})
it('finds the connected family without mixing projects and keeps missing-parent siblings', () => {
  const sessions = [{ id: 'a', cwd: '/w' }, { id: 'b', cwd: '/w', parentSessionId: 'a' }, { id: 'c', cwd: '/w', parentSessionId: 'a' }, { id: 'other', cwd: '/x', parentSessionId: 'a' }]
  expect(graphFamily(sessions, 'b').map((session) => session.id)).toEqual(['a', 'b', 'c'])
})
it('counts only whole inherited turns and detects changed content without using matching text', () => {
  const snapshot = { entries: [user('a', null), answer, user('b', 'answer')], revision: 'r1', bytes: 1 } as PiSessionHistorySnapshot
  const relation = { inherited_leaf_id: 'a' } as import('./session-branch-store.js').BranchRecord
  expect(graphTurnPage(snapshot, relation).inheritedCount).toBe(0)
  const inherited = graphTurnPage({ ...snapshot, entries: snapshot.entries.slice(0, 2) }, { ...relation, inherited_leaf_id: 'answer' })
  expect(inherited.inheritedCount).toBe(1)
  expect(inherited.entries[0].prefixDigest).toBe(graphTurnPage(snapshot, undefined).entries[0].prefixDigest)
  const other = { ...snapshot, entries: [{ ...snapshot.entries[0], id: 'different-id' }, ...snapshot.entries.slice(1)] } as PiSessionHistorySnapshot
  expect(graphTurnPage(other, undefined).entries[0].prefixDigest).not.toBe(inherited.entries[0].prefixDigest)
})
it('projects complete attachment markers before truncating the public prompt preview', () => {
  const raw = 'x'.repeat(200) + '<private-attachment-path>'
  const snapshot = { entries: [user('a', null, raw)], revision: 'r', bytes: 1 } as PiSessionHistorySnapshot
  let projected: string | undefined
  const page = graphTurnPage(snapshot, undefined, 0, 100, (text) => { projected = text; return '安全附件摘要' })
  expect(projected).toBe(raw)
  expect(page.entries[0].promptPreview).toBe('安全附件摘要')
})
