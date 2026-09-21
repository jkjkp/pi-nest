export type NavigationOrder = {
  projectOrder: string[]
  sessionOrderByProject: Record<string, string[]>
}

export type NavigationOrderSource = {
  key: string
  sessions: { id: string }[]
}

export const emptyNavigationOrder: NavigationOrder = { projectOrder: [], sessionOrderByProject: {} }

function orderKnownIds(ids: string[], knownIds: string[]) {
  const known = new Set(knownIds)
  const seen = new Set<string>()
  const ordered = ids.filter((id) => known.has(id) && !seen.has(id) && (seen.add(id), true))
  return [...ordered, ...knownIds.filter((id) => !seen.has(id))]
}

export function reconcileNavigationOrder(order: NavigationOrder, source: NavigationOrderSource[]): NavigationOrder {
  const projectKeys = source.map((project) => project.key)
  const sessionOrderByProject = Object.fromEntries(
    source.map((project) => [
      project.key,
      orderKnownIds(order.sessionOrderByProject[project.key] ?? [], project.sessions.map((session) => session.id)),
    ]),
  )

  return { projectOrder: orderKnownIds(order.projectOrder, projectKeys), sessionOrderByProject }
}

export function navigationOrdersEqual(left: NavigationOrder, right: NavigationOrder) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function applyNavigationOrder<T extends NavigationOrderSource>(source: T[], order: NavigationOrder): T[] {
  const projectPositions = new Map(order.projectOrder.map((key, index) => [key, index]))
  return [...source]
    .sort((left, right) => (projectPositions.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (projectPositions.get(right.key) ?? Number.MAX_SAFE_INTEGER))
    .map((project) => {
      const sessionPositions = new Map((order.sessionOrderByProject[project.key] ?? []).map((id, index) => [id, index]))
      return {
        ...project,
        sessions: [...project.sessions].sort(
          (left, right) => (sessionPositions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (sessionPositions.get(right.id) ?? Number.MAX_SAFE_INTEGER),
        ),
      }
    })
}
