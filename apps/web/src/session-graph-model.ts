import type { PiSessionSummary } from '@pi-nest/contracts'
import { sessionDisplayName } from './workspace.js'
import { buildSessionTree, flattenVisibleSessionTree } from './session-tree.js'

export type GraphNode = {
  id: string; label: string; summary: string; status?: string; x: number; y: number; parent?: string
  connectionLabel?: string; sourceEntryId?: string; notice?: string; hasChildren: boolean; collapsed: boolean
}

export function clampGraphSplitRatio(ratio: number, width: number) {
  if (!Number.isFinite(width) || width <= 0) return 0.45
  const minimum = Math.min(320, width / 2)
  const maximum = Math.max(minimum, width - 360)
  return Math.max(minimum, Math.min(maximum, (Number.isFinite(ratio) ? ratio : 0.45) * width)) / width
}

export function graphAncestors(sessions: PiSessionSummary[], id: string) {
  const tree = buildSessionTree(sessions)
  const path: string[] = []
  let cursor: string | undefined = id
  while (cursor && tree.sessions.has(cursor)) { path.push(cursor); cursor = tree.parents.get(cursor) }
  return path
}

export function layoutGraph(sessions: PiSessionSummary[], collapsed: Record<string, boolean> = {}): GraphNode[] {
  const tree = buildSessionTree(sessions.map((session) => session.branch?.issue ? { ...session, parentSessionId: undefined } : session))
  const rows = flattenVisibleSessionTree(tree, Object.fromEntries([...tree.sessions.keys()].map((id) => [id, collapsed[id] ?? false])))
  const positions = new Map<string, number>()
  let nextY = 24
  for (const row of rows) {
    if (!row.hasChildren || !row.expanded) { positions.set(row.session.id, nextY); nextY += 164 }
  }
  for (const row of [...rows].reverse()) {
    if (positions.has(row.session.id)) continue
    const children = tree.children.get(row.session.id)!
    positions.set(row.session.id, (positions.get(children[0])! + positions.get(children.at(-1)!)!) / 2)
  }
  return rows.map(({ session, depth, hasChildren, expanded }) => {
    const branch = session.branch
    const notice = branch?.issue || branch?.state === 'attention' ? '来源关系异常' : session.parentSessionMissing ? '来源会话缺失或关系异常' : undefined
    return {
      id: session.id, label: sessionDisplayName(session), summary: session.firstMessage || '暂无摘要',
      x: 24 + depth * 320, y: positions.get(session.id)!, parent: tree.parents.get(session.id),
      hasChildren, collapsed: !expanded, notice,
      connectionLabel: branch ? ({ edit: '修改某轮创建', continue: '从某轮之后继续', clone: '克隆会话' })[branch.mode] : session.parentSessionId ? '分叉位置未知' : undefined,
      sourceEntryId: branch?.sourceEntryId ?? undefined,
    }
  })
}
