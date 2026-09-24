import type { PromptStatus, SessionRunSummary } from './workspace-store.js'
import type { RuntimeStatus } from './runtime-websocket-client.js'
import { stripAnsiLine } from './ansi-text.js'

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

export function shouldFollowLatest(scrollHeight: number, scrollTop: number, clientHeight: number, navigationInProgress: boolean) {
  return !navigationInProgress && scrollHeight - scrollTop - clientHeight <= 80
}

export function extensionStatusLine(statuses: Record<string, string> | undefined) {
  return Object.keys(statuses ?? {})
    .sort()
    .map((key) => stripAnsiLine(statuses?.[key] ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

export function extensionWidgetText(widgets: Record<string, string[]> | undefined) {
  return Object.keys(widgets ?? {})
    .sort()
    .map((key) => (widgets?.[key] ?? []).map(stripAnsiLine).join('\n').trim())
    .filter(Boolean)
    .join('\n\n')
}

export function runtimeStatusLabel(runtime: Omit<RuntimeStatus, 'sessionId'> | undefined, localRunActive: boolean) {
  if (!runtime || localRunActive) return undefined
  if (runtime.lifecycle === 'loading') return '正在加载 Pi 运行时'
  if (runtime.lifecycle === 'active') return 'Pi 正在运行'
  if (runtime.lifecycle === 'failed') return runtime.error ? `Pi 运行时失败：${stripAnsiLine(runtime.error)}` : 'Pi 运行时失败'
  return undefined
}

export function runInspectorFields(run: SessionRunSummary | undefined) {
  const eventCount = run ? run.systemEvents.length + run.turns.reduce((count, turn) => count + turn.events.length, 0) : undefined
  return {
    error: run?.error,
    model: run?.model ?? '当前不可用',
    stopReason: run?.stopReason ?? '当前不可用',
    eventCount: eventCount === undefined ? '当前不可用' : String(eventCount),
  }
}
