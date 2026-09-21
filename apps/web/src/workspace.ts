import type { PromptStatus, SessionRunSummary } from './workspace-store.js'

export type PiSessionSummary = {
  cwd?: string
  firstMessage?: string
  id: string
  name?: string
  updatedAt?: string
}

export type ProjectSessionGroup = {
  cwd?: string
  key: string
  name: string
  sessions: PiSessionSummary[]
}

const sessionStatusLabels: Record<PromptStatus, string> = {
  aborted: '— 已中止',
  aborting: '● 正在停止',
  complete: '✓ 已完成',
  error: '× 请求失败',
  idle: '— 空闲',
  running: '● 推理中',
}

export function formatUpdatedAt(updatedAt?: string) {
  if (!updatedAt) return '未知时间'

  const date = new Date(updatedAt)
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString()
}

export function projectName(cwd?: string) {
  const segments = cwd?.split(/[\\/]/).filter(Boolean)
  return segments?.at(-1) ?? '未知项目'
}

export function projectSessionGroupKey(cwd?: string) {
  return cwd ? `cwd:${cwd}` : 'cwd:unavailable'
}

function updatedAtValue(updatedAt?: string) {
  const value = updatedAt ? Date.parse(updatedAt) : Number.NaN
  return Number.isNaN(value) ? undefined : value
}

function sortByUpdatedAt(sessions: PiSessionSummary[]) {
  return sessions
    .map((session, index) => ({ index, session, updatedAt: updatedAtValue(session.updatedAt) }))
    .sort((left, right) => {
      if (left.updatedAt === undefined) return right.updatedAt === undefined ? left.index - right.index : 1
      if (right.updatedAt === undefined) return -1
      return right.updatedAt - left.updatedAt || left.index - right.index
    })
}

export function groupSessionsByProject(sessions: PiSessionSummary[]): ProjectSessionGroup[] {
  const groups = new Map<string, { firstIndex: number; group: ProjectSessionGroup }>()

  sessions.forEach((session, index) => {
    const key = projectSessionGroupKey(session.cwd)
    const existing = groups.get(key)
    if (existing) {
      existing.group.sessions.push(session)
      return
    }

    groups.set(key, {
      firstIndex: index,
      group: {
        cwd: session.cwd,
        key,
        name: session.cwd ? projectName(session.cwd) : '工作目录不可用',
        sessions: [session],
      },
    })
  })

  return [...groups.values()]
    .map(({ firstIndex, group }) => {
      const sorted = sortByUpdatedAt(group.sessions)
      return { firstIndex, group: { ...group, sessions: sorted.map(({ session }) => session) }, latest: sorted[0]?.updatedAt }
    })
    .sort((left, right) => {
      if (left.latest === undefined) return right.latest === undefined ? left.firstIndex - right.firstIndex : 1
      if (right.latest === undefined) return -1
      return right.latest - left.latest || left.firstIndex - right.firstIndex
    })
    .map(({ group }) => group)
}

export function filterProjectsByQuery(projects: ProjectSessionGroup[], value: string) {
  const query = value.trim().toLocaleLowerCase()
  if (!query) return projects

  return projects.flatMap((project) => {
    if (`${project.name} ${project.cwd ?? ''}`.toLocaleLowerCase().includes(query)) return [project]

    const sessions = project.sessions.filter((session) => sessionDisplayName(session).toLocaleLowerCase().includes(query))
    return sessions.length > 0 ? [{ ...project, sessions }] : []
  })
}

export function sessionDisplayName(session: Pick<PiSessionSummary, 'name' | 'firstMessage'>) {
  return session.name ?? session.firstMessage ?? '未命名会话'
}

export function sessionStatusLabel(status: PromptStatus = 'idle') {
  return sessionStatusLabels[status]
}

export function shortSessionId(sessionId: string) {
  return sessionId.slice(0, 8)
}

export function runInspectorFields(run: SessionRunSummary | undefined) {
  return {
    error: run?.error,
    model: run?.model ?? '当前不可用',
    stopReason: run?.stopReason ?? '当前不可用',
    textDeltaCount: run?.textDeltaCount === undefined ? '当前不可用' : String(run.textDeltaCount),
  }
}
