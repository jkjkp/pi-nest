import type { PromptStatus } from './workspace-store.js'

export type PiSessionSummary = {
  cwd?: string
  id: string
  updatedAt?: string
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

export function sessionStatusLabel(status: PromptStatus = 'idle') {
  return sessionStatusLabels[status]
}

export function shortSessionId(sessionId: string) {
  return sessionId.slice(0, 8)
}
