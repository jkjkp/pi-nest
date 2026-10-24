import { expect, it } from 'vitest'
import { buildSessionTree, filterSessionTree, flattenVisibleSessionTree, reorderSessionSiblings, sessionAncestors } from './session-tree.js'

const sessions = [
  { id: 'c', name: 'Another try', parentSessionId: 'b' },
  { id: 'a', name: 'Login' },
  { id: 'x', name: 'Plan A', parentSessionId: 'a' },
  { id: 'b', name: 'Plan B', parentSessionId: 'a' },
  { id: 'root', name: 'Other' },
]
const ids = (tree: ReturnType<typeof buildSessionTree>, collapsed = {}, all = true) => flattenVisibleSessionTree(tree, collapsed, all).map((row) => row.session.id)

it('builds nested lineage in sibling order without mutating the flat source', () => {
  const tree = buildSessionTree(sessions)
  expect(ids(tree)).toEqual(['a', 'x', 'b', 'c', 'root'])
  expect(sessionAncestors(tree, 'c')).toEqual(['b', 'a'])
  expect(ids(tree, {}, false)).toEqual(['a', 'root'])
  expect(ids(tree, { a: false }, false)).toEqual(['a', 'x', 'b', 'root'])
  expect(ids(tree, { a: false, b: false }, false)).toEqual(['a', 'x', 'b', 'c', 'root'])
  expect(sessions.map((session) => session.id)).toEqual(['c', 'a', 'x', 'b', 'root'])
})

it('keeps matching descendants and their ancestors without unrelated siblings', () => {
  const tree = filterSessionTree(buildSessionTree(sessions), (session) => session.id === 'c')
  expect(ids(tree)).toEqual(['a', 'b', 'c'])
  expect(ids(tree, { a: true }, true)).toEqual(['a', 'b', 'c'])
})

it('promotes orphans, cross-project links, self references and cycles without losing descendants', () => {
  const input = [
    { id: 'missing', parentSessionId: 'gone' },
    { id: 'self', parentSessionId: 'self' },
    { id: 'a', parentSessionId: 'b' },
    { id: 'b', parentSessionId: 'a' },
    { id: 'c', parentSessionId: 'b' },
    { id: 'cross', cwd: '/other', parentSessionId: 'c' },
  ]
  const tree = buildSessionTree(input)
  expect(new Set(ids(tree))).toEqual(new Set(input.map((session) => session.id)))
  expect(ids(tree)).toHaveLength(input.length)
  expect(tree.parents).toEqual(new Map([['c', 'b']]))
  expect(buildSessionTree(sessions.filter((session) => session.id !== 'b')).parents.has('c')).toBe(false)
})

it('reorders only sibling slots and rejects moves across parents', () => {
  const tree = buildSessionTree(sessions)
  expect(reorderSessionSiblings(tree, 'x', 'b')).toEqual(['c', 'a', 'b', 'x', 'root'])
  expect(reorderSessionSiblings(tree, 'b', 'x')).toEqual(['c', 'a', 'b', 'x', 'root'])
  expect(reorderSessionSiblings(tree, 'c', 'a')).toBeUndefined()
  expect(reorderSessionSiblings(tree, 'unknown', 'a')).toBeUndefined()
})

it('handles deep trees iteratively and bounds visual guide storage', () => {
  const input = Array.from({ length: 2000 }, (_, index) => ({ id: String(index), parentSessionId: index ? String(index - 1) : undefined }))
  const rows = flattenVisibleSessionTree(buildSessionTree(input), {}, true)
  expect(rows).toHaveLength(2000)
  expect(rows.at(-1)?.depth).toBe(1999)
  expect(rows.at(-1)?.guides.length).toBeLessThanOrEqual(6)
})
