import type { PiSessionSummary } from './workspace.js'

export type SessionTree = {
  sessions: Map<string, PiSessionSummary>
  parents: Map<string, string>
  children: Map<string | undefined, string[]>
}

export function buildSessionTree(sessions: PiSessionSummary[]): SessionTree {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const parents = new Map<string, string>()
  for (const session of byId.values()) {
    const parent = byId.get(session.parentSessionId ?? '')
    if (parent && parent.id !== session.id && parent.cwd === session.cwd) parents.set(session.id, parent.id)
  }
  const visited = new Set<string>()
  for (const id of byId.keys()) {
    const path = new Set<string>()
    let cursor: string | undefined = id
    while (cursor && !visited.has(cursor) && !path.has(cursor)) {
      path.add(cursor)
      cursor = parents.get(cursor)
    }
    if (cursor && path.has(cursor)) {
      const cycleStart = cursor
      let cycleNode: string = cursor
      do {
        const next: string = parents.get(cycleNode)!
        parents.delete(cycleNode)
        cycleNode = next
      } while (cycleNode !== cycleStart)
    }
    for (const node of path) visited.add(node)
  }
  for (const session of byId.values()) {
    if (session.parentSessionId && !parents.has(session.id)) byId.set(session.id, { ...session, parentSessionMissing: true })
  }
  const children = new Map<string | undefined, string[]>()
  for (const id of byId.keys()) {
    const parent = parents.get(id)
    const siblings = children.get(parent) ?? []
    siblings.push(id)
    children.set(parent, siblings)
  }
  return { sessions: byId, parents, children }
}

export function sessionAncestors(tree: SessionTree, id: string) {
  const ancestors: string[] = []
  let parent = tree.parents.get(id)
  while (parent) {
    ancestors.push(parent)
    parent = tree.parents.get(parent)
  }
  return ancestors
}

export function filterSessionTree(tree: SessionTree, matches: (session: PiSessionSummary) => boolean): SessionTree {
  const keep = new Set<string>()
  for (const session of tree.sessions.values()) {
    if (!matches(session)) continue
    let id: string | undefined = session.id
    while (id && !keep.has(id)) {
      keep.add(id)
      id = tree.parents.get(id)
    }
  }
  return {
    sessions: new Map([...tree.sessions].filter(([id]) => keep.has(id))),
    parents: new Map([...tree.parents].filter(([id]) => keep.has(id))),
    children: new Map([...tree.children].map(([id, children]) => [id, children.filter((child) => keep.has(child))])),
  }
}

export function flattenVisibleSessionTree(tree: SessionTree, collapsed: Record<string, boolean>, expandAll = false) {
  const rows: { session: PiSessionSummary; depth: number; guides: boolean[]; last: boolean; hasChildren: boolean; expanded: boolean }[] = []
  const stack = [...(tree.children.get(undefined) ?? [])].reverse().map((id, index) => ({ id, depth: 0, guides: [] as boolean[], last: index === 0 }))
  while (stack.length) {
    const row = stack.pop()!
    const children = tree.children.get(row.id) ?? []
    const expanded = expandAll || collapsed[row.id] === false
    rows.push({ ...row, session: tree.sessions.get(row.id)!, hasChildren: children.length > 0, expanded })
    if (!expanded) continue
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ id: children[index], depth: row.depth + 1, guides: [...row.guides, !row.last].slice(-6), last: index === children.length - 1 })
    }
  }
  return rows
}

export function reorderSessionSiblings(tree: SessionTree, activeId: string, overId: string): string[] | undefined {
  if (!tree.sessions.has(activeId) || !tree.sessions.has(overId) || tree.parents.get(activeId) !== tree.parents.get(overId)) return
  const siblings = [...tree.children.get(tree.parents.get(activeId))!]
  const overIndex = siblings.indexOf(overId)
  siblings.splice(siblings.indexOf(activeId), 1)
  siblings.splice(overIndex, 0, activeId)
  const siblingIds = new Set(siblings)
  let index = 0
  return [...tree.sessions.keys()].map((id) => siblingIds.has(id) ? siblings[index++] : id)
}
