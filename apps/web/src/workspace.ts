import type { PiProject } from '@pi-nest/contracts'
import type { PiSessionSummary, RuntimeStatus } from '@pi-nest/contracts'
import type { PromptStatus, SessionRunSummary } from './session-run-model.js'
import { stripAnsiLine } from './ansi-text.js'

export type { PiSessionSummary } from '@pi-nest/contracts'

export type ProjectSessionGroup = {
  createdAt?: string
  cwd?: string
  key: string
  name: string
  sessions: PiSessionSummary[]
}

const sessionStatusLabels: Record<PromptStatus, string> = {
  aborted: '— 已中止',
  aborting: '● 正在停止',
  awaiting_agent: '◌ Pi 已接收，正在准备执行',
  awaiting_input: '◌ 等待你的回答',
  complete: '✓ 已完成',
  error: '× 请求失败',
  idle: '— 空闲',
  running: '● 推理中',
  submitted: '◌ 已提交，正在连接 Pi',
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

function createdAtValue(createdAt?: string) {
  const value = createdAt ? Date.parse(createdAt) : Number.NaN
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value
}

export function groupSessionsByProject(sessions: PiSessionSummary[], projectCreatedAt: Record<string, string> = {}, registeredProjects: PiProject[] = []): ProjectSessionGroup[] {
  const groups = new Map<string, ProjectSessionGroup>()
  for (const project of registeredProjects) {
    const key = projectSessionGroupKey(project.cwd)
    groups.set(key, { ...project, key, name: projectName(project.cwd), sessions: [] })
  }
  for (const session of sessions) {
    const key = projectSessionGroupKey(session.cwd)
    const existing = groups.get(key)
    if (existing) existing.sessions.push(session)
    else groups.set(key, { cwd: session.cwd, key, name: session.cwd ? projectName(session.cwd) : '工作目录不可用', sessions: [session] })
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = [...group.sessions].sort((left, right) => createdAtValue(right.createdAt) - createdAtValue(left.createdAt) || left.id.localeCompare(right.id))
      const earliest = sorted.filter((session) => Number.isFinite(createdAtValue(session.createdAt))).at(-1)?.createdAt
      return { ...group, createdAt: projectCreatedAt[group.key] ?? group.createdAt ?? earliest, sessions: sorted }
    })
    .sort((left, right) => createdAtValue(right.createdAt) - createdAtValue(left.createdAt) || left.key.localeCompare(right.key))
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
    .filter((key) => key !== 'plan-mode')
    .sort()
    .map((key) => stripAnsiLine(statuses?.[key] ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

export function extensionWidgetText(widgets: Record<string, string[]> | undefined) {
  return Object.keys(widgets ?? {})
    .filter((key) => key !== 'plan-mode-plan')
    .sort()
    .map((key) => (widgets?.[key] ?? []).map(stripAnsiLine).join('\n').trim())
    .filter(Boolean)
    .join('\n\n')
}

export function planModePolicy(widgets: Record<string, string[]> | undefined) {
  return widgets?.['plan-mode-plan']?.map(stripAnsiLine).find((line) => line.startsWith('Plan policy allows:'))?.replace(' Model-visible tools stay unchanged.', '').trim()
}

export function runtimeStatusLabel(runtime: Omit<RuntimeStatus, 'sessionId'> | undefined, localRunActive: boolean) {
  if (!runtime || localRunActive) return undefined
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
