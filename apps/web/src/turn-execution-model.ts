import type { PiFileChange } from '@pi-nest/contracts'
import { projectToolResult, type ToolResult } from './tool-result-model.js'
import { isRunActive, type PromptStatus } from './session-run-model.js'
import { duration, type TimelineEvent, type TimelineItem, type TimelinePart } from './timeline-model.js'

export type TurnActivity =
  | { id: string; kind: 'thinking' | 'narration'; text: string }
  | { duration: number | undefined; events: TimelineEvent[]; id: string; kind: 'tool'; label: string; status: string; result?: ToolResult }
  | { command: string | undefined; cwd: string | undefined; duration: number | undefined; events: TimelineEvent[]; exitCode: number | undefined; id: string; kind: 'bash'; status: string; stderr: string | undefined; stdout: string | undefined }
  | { changes: FileChange[]; id: string; kind: 'file_change'; label: string }
  | { id: string; kind: 'retry'; label: string }

export type FileChange = { added: number | undefined; path: string; removed: number | undefined }

export type TurnPresentation = {
  activities: TurnActivity[]
  finalAnswer: Extract<TimelinePart, { kind: 'assistant_text' }>[]
  hasExecution: boolean
}

const presentationCache = new WeakMap<TimelineItem, { completed?: TurnPresentation; running?: TurnPresentation }>()

function activityText(events: TimelineEvent[], key: keyof NonNullable<TimelineEvent['activityText']>) {
  return events.findLast((event) => event.activityText?.[key])?.activityText?.[key]
}

function argument(part: Extract<TimelinePart, { kind: 'tool' }>, key: string) {
  return typeof part.arguments?.[key] === 'string' && part.arguments[key] ? part.arguments[key] : undefined
}

function humanize(value: string) {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function toolLabel(part: Extract<TimelinePart, { kind: 'tool' }>) {
  const name = part.toolName.toLowerCase()
  const path = argument(part, 'path') ?? argument(part, 'filePath') ?? argument(part, 'filename') ?? activityText(part.events, 'path')
  const query = argument(part, 'query') ?? argument(part, 'pattern') ?? activityText(part.events, 'query')
  const command = argument(part, 'command') ?? activityText(part.events, 'command')
  if (/(read|fetch|cat)/.test(name)) return path ? `读取 ${path}` : '读取文件'
  if (/(search|grep|find)/.test(name)) return query ? `搜索 ${query}` : '搜索内容'
  if (/(edit|write|patch|update)/.test(name)) return path ? `编辑 ${path}` : '编辑文件'
  if (/(bash|shell|exec|command)/.test(name)) return command ? `运行 ${command}` : '运行命令'
  return humanize(part.toolName)
}

function activity(part: TimelinePart, index: number, isRunning: boolean): TurnActivity {
  const id = `${part.kind}-${part.events[0]?.id ?? index}-${index}`
  if (part.kind === 'thinking') return { id, kind: 'thinking', text: part.text }
  if (part.kind === 'assistant_text') return { id, kind: 'narration', text: part.text }
  if (part.kind === 'tool') {
    const result = projectToolResult(part, !isRunning)
    return { duration: duration(part.events), events: part.events, id, kind: 'tool', label: toolLabel(part), status: result.status, result }
  }
  if (part.kind === 'bash') {
    const bash = part.events.flatMap(({ reading }) => reading.kind === 'bash' ? [reading] : [])
    const exitCode = bash.findLast((event) => event.exitCode !== undefined)?.exitCode
    return { command: activityText(part.events, 'command'), cwd: activityText(part.events, 'cwd'), duration: duration(part.events), events: part.events, exitCode, id, kind: 'bash', status: exitCode === undefined ? bash.some((event) => event.ended) ? '已结束（退出码未记录）' : isRunning ? '正在执行' : '结果未记录' : exitCode === 0 ? '完成' : '失败', stderr: activityText(part.events, 'stderr'), stdout: activityText(part.events, 'stdout') }
  }
  if (part.kind === 'retry') {
    const last = part.events.at(-1)?.reading
    return { id, kind: 'retry', label: last?.kind === 'retry' && last.retrying ? '连接异常，Pi 正在重试…' : '已结束重试' }
  }
  const changes = part.events.flatMap(({ reading }) => reading.kind === 'file_change' ? reading.changes : [])
  return { changes, id, kind: 'file_change', label: changes.length ? `编辑 ${changes.length} 个文件` : '文件修改' }
}

function createTurnPresentation(item: TimelineItem, isRunning: boolean): TurnPresentation {
  const parts = item.plan ? item.parts.filter((part) => part.kind !== 'assistant_text' || part.text.replace(/^\*\*Proposed Plan\*\*\s*/, '').trim() !== item.plan!.text.replace(/^\*\*Proposed Plan\*\*\s*/, '').trim()) : item.parts
  const lastExecutionIndex = parts.reduce((last, part, index) => part.kind === 'assistant_text' ? last : index, -1)
  if (lastExecutionIndex < 0) return { activities: [], finalAnswer: parts.filter((part): part is Extract<TimelinePart, { kind: 'assistant_text' }> => part.kind === 'assistant_text'), hasExecution: false }

  const finalIndexes = new Set(parts.flatMap((part, index) => part.kind === 'assistant_text' && index > lastExecutionIndex ? [index] : []))
  if (!isRunning && finalIndexes.size === 0) {
    const fallback = parts.reduce((last, part, index) => part.kind === 'assistant_text' ? index : last, -1)
    if (fallback >= 0) finalIndexes.add(fallback)
  }

  return {
    activities: parts.flatMap((part, index) => part.kind === 'assistant_text' && finalIndexes.has(index) ? [] : [activity(part, index, isRunning)]),
    finalAnswer: parts.flatMap((part, index) => part.kind === 'assistant_text' && finalIndexes.has(index) ? [part] : []),
    hasExecution: true,
  }
}

export function projectTurnPresentation(item: TimelineItem, isRunning: boolean): TurnPresentation {
  const cached = presentationCache.get(item)
  const key = isRunning ? 'running' : 'completed'
  if (cached?.[key]) return cached[key]
  const presentation = createTurnPresentation(item, isRunning)
  const entry = cached ?? {}
  entry[key] = presentation
  presentationCache.set(item, entry)
  return presentation
}

export function turnCompletedAt(item: TimelineItem) {
  return item.events.findLast((event) => event.completesTurn)?.observedAt
}

export function turnElapsed(item: TimelineItem, isRunning: boolean, now = Date.now()) {
  const startedAt = Date.parse(item.runtimeTiming?.startedAt ?? item.startedAt)
  const endedAt = isRunning ? now : Date.parse(item.runtimeTiming?.completedAt ?? turnCompletedAt(item) ?? '')
  return Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : undefined
}

export function formatElapsedTime(milliseconds: number | undefined) {
  if (milliseconds === undefined) return '—'
  const seconds = Math.floor(milliseconds / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor(seconds % 3_600 / 60)
  const remainder = seconds % 60
  if (hours) return `${hours}小时${String(minutes).padStart(2, '0')}分${String(remainder).padStart(2, '0')}秒`
  if (minutes) return `${minutes}分${String(remainder).padStart(2, '0')}秒`
  return `${remainder}秒`
}

export function formatActivityDuration(milliseconds: number | undefined) {
  return milliseconds !== undefined && milliseconds < 1_000 ? `${milliseconds} ms` : formatElapsedTime(milliseconds)
}

export function nextExecutionExpanded(expanded: boolean, wasRunning: boolean, isRunning: boolean, userToggled: boolean) {
  if (userToggled) return expanded
  if (!wasRunning && isRunning) return true
  return wasRunning && !isRunning ? false : expanded
}

export function executionPhase(item: TimelineItem, presentation: TurnPresentation, status?: PromptStatus, waitingMessage?: string) {
  if (status === 'submitted') return '已提交，正在连接 Pi…'
  if (status === 'awaiting_agent') return waitingMessage ?? 'Pi 已接收，正在准备执行…'
  if (status === 'awaiting_input') return '等待你的回答…'
  if (status === 'aborting') return '正在停止…'
  if (status === 'aborted') return '已停止'
  if (status === 'error') return '执行失败'
  const activeTool = [...presentation.activities].reverse().find((activity) => (activity.kind === 'tool' || activity.kind === 'bash') && activity.status === '正在执行')
  if (activeTool?.kind === 'tool') return activeTool.label
  if (activeTool?.kind === 'bash') return '运行命令'
  const latest = item.events.findLast((event) => event.phase || event.endsTool)
  if (latest?.phase === 'thinking') return '思考中'
  if (latest?.phase === 'answering') return '正在回答'
  return '等待模型响应'
}

export type TurnFileChange = {
  path: string
  displayPath: string
  outsideProject: boolean
  statistics?: PiFileChange
  operations: Extract<TurnActivity, { kind: 'tool' }>[]
  reported: boolean
  status: string
  changes?: { added: number; removed: number }
}

function normalizeFilePath(path: string, windows = false) {
  const value = windows || /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replace(/\\/g, '/') : path
  const prefix = value.match(/^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/i)?.[0] ?? ''
  const segments: string[] = []
  for (const segment of value.slice(prefix.length).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..' && segments.length && segments.at(-1) !== '..') segments.pop()
    else if (segment !== '..' || !prefix) segments.push(segment)
  }
  return `${prefix}${segments.join('/')}` || '.'
}

function absoluteFilePath(path: string) { return path.startsWith('/') || /^[a-z]:\//i.test(path) }
function fileIdentity(path: string) { return /^[a-z]:\/|^\/\//i.test(path) ? path.toLowerCase() : path }

export function projectTurnFiles(activities: TurnActivity[], cwd?: string, finalStatistics: PiFileChange[] = []): TurnFileChange[] {
  const normalizedCwd = cwd && normalizeFilePath(cwd)
  const root = normalizedCwd && absoluteFilePath(normalizedCwd) ? normalizedCwd.replace(/\/$/, '') : undefined
  const windows = root !== undefined && /^[a-z]:\/|^\/\//i.test(root)
  const files = new Map<string, TurnFileChange>()
  function file(path: string, operationCwd = cwd) {
    const normalizedBase = operationCwd && normalizeFilePath(operationCwd, windows)
    const base = normalizedBase && absoluteFilePath(normalizedBase) ? normalizedBase : root && normalizedBase ? `${root}/${normalizedBase}` : root
    const normalizedPath = normalizeFilePath(path, windows)
    const resolved = normalizeFilePath(absoluteFilePath(normalizedPath) || !base ? normalizedPath : `${base}/${normalizedPath}`)
    const identity = fileIdentity(resolved)
    let entry = files.get(identity)
    if (!entry) {
      const withinRoot = root !== undefined && identity.startsWith(`${fileIdentity(root)}/`)
      entry = { path: resolved, displayPath: withinRoot ? resolved.slice(root.length + 1) : resolved, outsideProject: root !== undefined && absoluteFilePath(resolved) && !withinRoot, operations: [], reported: false, status: '已修改' }
      files.set(identity, entry)
    }
    return entry
  }
  for (const activity of activities) {
    if (activity.kind === 'tool' && activity.result?.path && ['edit', 'write'].includes(activity.result.view)) {
      const entry = file(activity.result.fileChange?.path ?? activity.result.path, activity.result.cwd ?? cwd)
      const stats = activity.result.fileChange
      if (stats && (!entry.statistics || stats.sequence >= entry.statistics.sequence)) entry.statistics = stats
      if (stats && 'changeType' in stats && stats.changeType !== 'unchanged') entry.reported = true
      const callId = activity.events.find((event) => event.tool?.id !== undefined)?.tool?.id
      const duplicate = callId && entry.operations.some((operation) => operation.events.some((event) => event.tool?.rootId === callId || event.tool?.messageId === callId))
      if (!duplicate) entry.operations.push(activity)
    } else if (activity.kind === 'file_change') {
      for (const change of activity.changes) file(change.path).reported = true
    }
  }
  for (const stats of finalStatistics) {
    const entry = file(stats.path)
    entry.statistics = stats
    entry.reported = true
  }
  return [...files.values()].filter((entry) => {
    const successes = entry.operations.filter((operation) => operation.result?.status === '完成')
    if (!successes.length && !entry.reported) return false
    if (successes.length > 1) entry.status = successes.every((operation) => operation.result?.view === 'edit') ? '多次编辑' : '多次修改'
    else if (successes.length) entry.status = successes[0]?.result?.view === 'write' ? '已写入' : '已编辑'
    const lastSuccess = entry.operations.findLastIndex((operation) => operation.result?.status === '完成')
    const later = entry.operations.slice(lastSuccess + 1)
    if (later.some((operation) => operation.result?.status === '失败')) entry.status += lastSuccess >= 0 ? ' · 后续操作失败' : ' · 含失败操作'
    else if (later.length) entry.status += lastSuccess >= 0 ? ' · 后续结果未确认' : ' · 含未确认操作'
    if (entry.statistics && 'added' in entry.statistics) {
      entry.changes = { added: entry.statistics.added, removed: entry.statistics.removed }
      if (entry.statistics.changeType === 'deleted') entry.status = ['已删除', ...entry.status.split(' · ').slice(1)].join(' · ')
      else if (entry.statistics.changeType === 'unchanged') entry.status += ' · 无净变化'
    } else if (!entry.statistics && successes.length === 1 && successes[0]?.result?.view === 'edit') entry.changes = successes[0].result.changes
    return true
  })
}

export type TurnFileSummaryState = 'complete' | 'aborted' | 'error'

export function turnFileSummaryState(item: TimelineItem, isRunning: boolean, runStatus?: PromptStatus, hasFollowingTurn = false): TurnFileSummaryState | undefined {
  if (isRunning || runStatus && isRunActive(runStatus) || item.steering && item.steering.status !== 'applied') return undefined
  if (runStatus === 'aborted' || runStatus === 'error') return runStatus
  const stopReason = item.events.findLast((event) => event.assistant)?.assistant?.stopReason
  const terminal = item.events.findLast((event) => event.settlement)
  if (stopReason === 'aborted' || terminal?.settlement === 'aborted') return 'aborted'
  if (stopReason === 'error') return 'error'
  if (runStatus === 'complete' || item.runtimeTiming?.completedAt || terminal || stopReason === 'stop' || stopReason === 'length' || hasFollowingTurn) return 'complete'
  return undefined
}
