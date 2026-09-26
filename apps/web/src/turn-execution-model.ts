import { duration, toolStatus, type TimelineEvent, type TimelineItem, type TimelinePart } from './timeline-model.js'

export type TurnActivity =
  | { id: string; kind: 'thinking' | 'narration'; text: string }
  | { duration: number | undefined; events: TimelineEvent[]; id: string; kind: 'tool'; label: string; status: string }
  | { command: string | undefined; cwd: string | undefined; duration: number | undefined; events: TimelineEvent[]; exitCode: number | undefined; id: string; kind: 'bash'; status: string; stderr: string | undefined; stdout: string | undefined }
  | { changes: FileChange[]; id: string; kind: 'file_change'; label: string }

export type FileChange = { added: number | undefined; path: string; removed: number | undefined }

export type TurnPresentation = {
  activities: TurnActivity[]
  finalAnswer: Extract<TimelinePart, { kind: 'assistant_text' }>[]
  hasExecution: boolean
}

function record(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function eventType(event: TimelineEvent) {
  return typeof event.event.type === 'string' ? event.event.type : ''
}

function text(events: TimelineEvent[], ...keys: string[]) {
  for (const event of [...events].reverse()) {
    const values = [event.event, record(event.event.args), record(event.event.input), record(event.event.parameters)]
    for (const value of values) for (const key of keys) if (typeof value?.[key] === 'string' && value[key]) return value[key] as string
  }
  return undefined
}

function number(events: TimelineEvent[], key: string) {
  for (const event of [...events].reverse()) if (typeof event.event[key] === 'number') return event.event[key] as number
  return undefined
}

function humanize(value: string) {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function toolLabel(part: Extract<TimelinePart, { kind: 'tool' }>) {
  const name = part.toolName.toLowerCase()
  const path = text(part.events, 'path', 'filePath', 'filename')
  const query = text(part.events, 'query', 'pattern')
  const command = text(part.events, 'command')
  if (/(read|fetch|cat)/.test(name)) return path ? `读取 ${path}` : '读取文件'
  if (/(search|grep|find)/.test(name)) return query ? `搜索 ${query}` : '搜索内容'
  if (/(edit|write|patch|update)/.test(name)) return path ? `编辑 ${path}` : '编辑文件'
  if (/(bash|shell|exec|command)/.test(name)) return command ? `运行 ${command}` : '运行命令'
  return humanize(part.toolName)
}

function fileChanges(events: TimelineEvent[]) {
  const changes: FileChange[] = []
  for (const event of events) {
    const candidates = Array.isArray(event.event.changes) ? event.event.changes : [event.event]
    for (const candidate of candidates) {
      const value = record(candidate)
      const path = typeof value?.path === 'string' ? value.path : typeof value?.filePath === 'string' ? value.filePath : undefined
      if (path && value) changes.push({ added: typeof value.added === 'number' ? value.added : undefined, path, removed: typeof value.removed === 'number' ? value.removed : undefined })
    }
  }
  return changes
}

function activity(part: TimelinePart, index: number): TurnActivity {
  const id = `${part.kind}-${part.events[0]?.id ?? index}-${index}`
  if (part.kind === 'thinking') return { id, kind: 'thinking', text: part.text }
  if (part.kind === 'assistant_text') return { id, kind: 'narration', text: part.text }
  if (part.kind === 'tool') return { duration: duration(part.events), events: part.events, id, kind: 'tool', label: toolLabel(part), status: toolStatus(part.events) }
  if (part.kind === 'bash') {
    const exitCode = number(part.events, 'exitCode')
    return { command: text(part.events, 'command'), cwd: text(part.events, 'cwd'), duration: duration(part.events), events: part.events, exitCode, id, kind: 'bash', status: exitCode === undefined ? '正在执行' : exitCode === 0 ? '完成' : '失败', stderr: text(part.events, 'stderr'), stdout: text(part.events, 'stdout', 'output', 'delta') }
  }
  const changes = fileChanges(part.events)
  return { changes, id, kind: 'file_change', label: changes.length ? `编辑 ${changes.length} 个文件` : '文件修改' }
}

export function projectTurnPresentation(item: TimelineItem, isRunning: boolean): TurnPresentation {
  const lastExecutionIndex = item.parts.reduce((last, part, index) => part.kind === 'assistant_text' ? last : index, -1)
  if (lastExecutionIndex < 0) return { activities: [], finalAnswer: item.parts.filter((part): part is Extract<TimelinePart, { kind: 'assistant_text' }> => part.kind === 'assistant_text'), hasExecution: false }

  const finalIndexes = new Set(item.parts.flatMap((part, index) => part.kind === 'assistant_text' && index > lastExecutionIndex ? [index] : []))
  if (!isRunning && finalIndexes.size === 0) {
    const fallback = item.parts.reduce((last, part, index) => part.kind === 'assistant_text' ? index : last, -1)
    if (fallback >= 0) finalIndexes.add(fallback)
  }

  return {
    activities: item.parts.flatMap((part, index) => part.kind === 'assistant_text' && finalIndexes.has(index) ? [] : [activity(part, index)]),
    finalAnswer: item.parts.flatMap((part, index) => part.kind === 'assistant_text' && finalIndexes.has(index) ? [part] : []),
    hasExecution: true,
  }
}

export function turnCompletedAt(item: TimelineItem) {
  const terminal = [...item.events].reverse().find((event) => ['turn_end', 'agent_end', 'agent_settled', 'aborted'].includes(eventType(event)))
  return terminal?.observedAt ?? item.events.at(-1)?.observedAt
}

export function turnElapsed(item: TimelineItem, isRunning: boolean, now = Date.now()) {
  const startedAt = Date.parse(item.startedAt)
  const endedAt = isRunning ? now : Date.parse(turnCompletedAt(item) ?? '')
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
  return wasRunning && !isRunning && !userToggled ? false : expanded
}
