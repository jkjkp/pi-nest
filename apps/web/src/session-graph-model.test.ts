import { expect, it } from 'vitest'
import { layoutGraph } from './session-graph-model.js'
import type { PiSessionSummary } from '@pi-nest/contracts'
const relation = (parentSessionId: string, mode: 'edit' | 'continue' | 'clone' = 'edit') => ({ operationId: 'op', parentSessionId, sourceEntryId: 'message', inheritedLeafId: 'leaf', mode, state: 'ready' as const })
const root: PiSessionSummary = { id: 'root', cwd: '/w', name: '根会话', firstMessage: '已有摘要' }
it('uses exactly one sessionId node for each independent file, regardless of rounds or edits', () => {
  const sessions = [root, ...['edit', 'continue', 'clone'].map((mode, index) => ({ id: `s${index}`, cwd: '/w', parentSessionId: root.id, branch: relation(root.id, mode as 'edit' | 'continue' | 'clone') }))]
  const nodes = layoutGraph(sessions)
  expect(nodes.map((node) => node.id)).toEqual(['root', 's0', 's1', 's2'])
  expect(nodes.filter((node) => node.parent === root.id)).toHaveLength(3)
  expect(nodes[0]).toMatchObject({ label: '根会话', summary: '已有摘要' })
  expect(nodes.map((node) => node.connectionLabel)).toContain('克隆会话')
  expect(layoutGraph([root, { ...root, name: '末条编辑后的原会话' }])).toHaveLength(1)
})
it('lays out a tree, folds only descendants and preserves the actual input relationships', () => {
  const sessions = [root, { id: 'child', cwd: '/w', parentSessionId: 'root' }, { id: 'grandchild', cwd: '/w', parentSessionId: 'child' }]
  const nodes = layoutGraph(sessions)
  expect(nodes.map((node) => node.x)).toEqual([24, 344, 664])
  expect(layoutGraph(sessions, { child: true }).map((node) => node.id)).toEqual(['root', 'child'])
  expect(sessions[2].parentSessionId).toBe('child')
  expect(nodes[1].connectionLabel).toBe('分叉位置未知')
})
it('keeps missing, cross-project, cyclic and conflicting relationships visible without unsafe edges', () => {
  const sessions: PiSessionSummary[] = [root, { id: 'missing', cwd: '/w', parentSessionId: 'gone' }, { id: 'cross', cwd: '/other', parentSessionId: 'root' }, { id: 'a', cwd: '/w', parentSessionId: 'b' }, { id: 'b', cwd: '/w', parentSessionId: 'a' }, { id: 'conflict', cwd: '/w', parentSessionId: 'root', branch: { ...relation('different'), issue: 'conflict' } }]
  const nodes = layoutGraph(sessions)
  expect(nodes).toHaveLength(6)
  expect(nodes.slice(1).every((node) => !node.parent && Boolean(node.notice))).toBe(true)
})
it('100 independent sessions produce 100 nodes even with 10000 rounds in their native histories', () => {
  const sessions = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, cwd: '/w', firstMessage: `会话 ${i} 的已有摘要`, parentSessionId: i ? `s${i - 1}` : undefined }))
  const nodes = layoutGraph(sessions)
  expect(nodes).toHaveLength(100)
  expect(new Set(nodes.map((node) => node.id)).size).toBe(100)
})
