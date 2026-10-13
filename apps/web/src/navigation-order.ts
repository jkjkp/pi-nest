export type NavigationOrder = {
  projectOrder: string[]
  sessionOrderByProject: Record<string, string[]>
  projectCreatedAt?: Record<string, string>
}

export type NavigationOrderSource = {
  key: string
  createdAt?: string
  sessions: { id: string }[]
}

export const emptyNavigationOrder: NavigationOrder = { projectOrder: [], sessionOrderByProject: {} }

function orderKnownIds(ids: string[], knownIds: string[]) {
  const known = new Set(knownIds)
  const seen = new Set<string>()
  const ordered = ids.filter((id) => known.has(id) && !seen.has(id) && (seen.add(id), true))
  return [...knownIds.filter((id) => !seen.has(id)), ...ordered]
}

export function reconcileNavigationOrder(order: NavigationOrder, source: NavigationOrderSource[]): NavigationOrder {
  const projectKeys = source.map((project) => project.key)
  const projectCreatedAt = { ...order.projectCreatedAt }
  for (const project of source) {
    if (!projectCreatedAt[project.key] && project.createdAt) projectCreatedAt[project.key] = project.createdAt
  }
  const sessionOrderByProject = Object.fromEntries(
    source.filter((project) => order.sessionOrderByProject[project.key]?.length).map((project) => [
      project.key,
      orderKnownIds(order.sessionOrderByProject[project.key] ?? [], project.sessions.map((session) => session.id)),
    ]),
  )

  return { projectOrder: order.projectOrder.length ? orderKnownIds(order.projectOrder, projectKeys) : [], sessionOrderByProject, projectCreatedAt }
}

export function navigationOrdersEqual(left: NavigationOrder, right: NavigationOrder) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function applyNavigationOrder<T extends NavigationOrderSource>(source: T[], order: NavigationOrder): T[] {
  const projectPositions = new Map(order.projectOrder.map((key, index) => [key, index]))
  return [...source]
    .sort((left, right) => (projectPositions.get(left.key) ?? -1) - (projectPositions.get(right.key) ?? -1))
    .map((project) => {
      const sessionPositions = new Map((order.sessionOrderByProject[project.key] ?? []).map((id, index) => [id, index]))
      return {
        ...project,
        sessions: [...project.sessions].sort(
          (left, right) => (sessionPositions.get(left.id) ?? -1) - (sessionPositions.get(right.id) ?? -1),
        ),
      }
    })
}
