import type { PiFileChange, PiRuntimeEvent, PiSessionHistoryEntry } from '@pi-nest/contracts'
import { piToolCallId } from '@pi-nest/contracts/pi-events'
import { fileChangeStatistics } from './file-change-statistics.js'
import { modelCallError, type ModelCallError } from './model-call-error.js'
import { messageText, record, userMessageView } from './pi-message-view.js'

type TextBlock = { kind: 'assistant_text' | 'thinking'; text: string; index: number }
type ToolCall = { id?: string; name?: string; arguments?: Record<string, unknown> }
type Block = TextBlock | ({ kind: 'tool' } & ToolCall)
type UserMessage = ReturnType<typeof userMessageView>
type FileChange = { added: number | undefined; path: string; removed: number | undefined }
type Output = ReturnType<typeof toolOutput>
type Diagnostic = 'metadata' | 'unrenderable_message' | 'unknown'
type Reading =
  | { kind: 'assistant_started' }
  | { kind: 'assistant_message'; blocks: Block[]; error?: ModelCallError; reset: boolean }
  | { kind: 'text_delta'; block: TextBlock }
  | { kind: 'user'; message: UserMessage }
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'bash'; ended: boolean; exitCode?: number }
  | { kind: 'retry'; retrying: boolean }
  | { kind: 'file_change'; changes: FileChange[] }
  | { kind: 'diagnostic'; reason: Diagnostic }

type ActivityText = { path?: string; query?: string; command?: string; cwd?: string; stderr?: string; stdout?: string }

export type TimelineEvent = {
  id: string
  observedAt: string
  raw: Record<string, unknown>
  runtime?: Omit<PiRuntimeEvent, 'event'>
  nativeType: string
  reading: Reading
  user?: UserMessage
  assistant?: { stopReason?: string }
  historyMessage?: boolean
  branchable?: boolean
  completesTurn?: boolean
  settlement?: 'finished' | 'aborted'
  settledRun?: boolean
  phase?: 'thinking' | 'answering' | 'waiting'
  endsTool?: boolean
  activityText?: ActivityText
  tool?: {
    id?: string
    rootId?: string
    messageId?: string
    terminal: boolean
    partial: boolean
    failed: boolean
    readonly output?: Output
  }
  planCompletion?: { text: string; id: string }
  proposedPlan?: { text?: string }
}

function assistantBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ kind: 'assistant_text', text: content, index: 0 }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap<Block>((block, index) => {
    const value = record(block)
    if (value?.type === 'text' && typeof value.text === 'string') return [{ kind: 'assistant_text', text: value.text, index }]
    if (value?.type === 'thinking' && typeof value.thinking === 'string') return [{ kind: 'thinking', text: value.thinking, index }]
    if (value?.type === 'toolCall' && typeof value.id === 'string' && typeof value.name === 'string') return [{ kind: 'tool', id: value.id, name: value.name, arguments: record(value.arguments) }]
    return []
  })
}

function toolOutput(payload: Record<string, unknown> | undefined, error: unknown) {
  const details = record(payload?.details) ?? {}
  const content = payload?.content
  const output = messageText(content, '\n') || (error ? typeof error === 'string' ? error : JSON.stringify(error) : '')
  const notices: string[] = []
  if (record(details.truncation)?.truncated === true) notices.push('工具返回的内容已截断')
  if (typeof details.matchLimitReached === 'number') notices.push(`已达到 ${details.matchLimitReached} 条匹配上限，并非全部结果`)
  if (details.linesTruncated === true) notices.push('部分匹配行已截断')
  if (typeof details.fullOutputPath === 'string') notices.push(`完整输出保存在 ${details.fullOutputPath}`)
  if (Array.isArray(content) && content.some((block) => record(block)?.type !== 'text')) notices.push('结果包含非文本内容，此处仅展示文本')
  return {
    output, notices, patch: string(details.patch), diff: string(details.diff), fileChange: fileChangeStatistics(details.piNestFileChange),
    exitCode: typeof details.exitCode === 'number' ? details.exitCode : undefined,
    firstChangedLine: typeof details.firstChangedLine === 'number' ? details.firstChangedLine : undefined,
  }
}

function string(value: unknown) { return typeof value === 'string' ? value : undefined }

function activityText(raw: Record<string, unknown>): ActivityText {
  const values = [raw, record(raw.arguments), record(raw.args), record(raw.input), record(raw.parameters)]
  function text(...keys: string[]) {
    for (const value of values) for (const key of keys) {
      const candidate = string(value?.[key])
      if (candidate) return candidate
    }
    return undefined
  }
  return { path: text('path', 'filePath', 'filename'), query: text('query', 'pattern'), command: text('command'), cwd: text('cwd'), stderr: text('stderr'), stdout: text('stdout', 'output', 'delta') }
}

function fileChanges(raw: Record<string, unknown>): FileChange[] {
  if (raw.isError === true || raw.error) return []
  const candidates = Array.isArray(raw.changes) ? raw.changes : [raw]
  return candidates.flatMap((candidate) => {
    const value = record(candidate)
    const path = string(value?.path) ?? string(value?.filePath)
    return path && value && value.isError !== true && !value.error
      ? [{ path, added: typeof value.added === 'number' ? value.added : undefined, removed: typeof value.removed === 'number' ? value.removed : undefined }]
      : []
  })
}

function reading(raw: Record<string, unknown>, type: string, message: Record<string, unknown> | undefined, user: UserMessage | undefined, update: Record<string, unknown> | undefined): Reading {
  if (type === 'message_start' && message?.role === 'assistant') return { kind: 'assistant_started' }
  if (type === 'message_update') {
    const delta = string(update?.delta)
    const updateType = string(update?.type)
    if (delta !== undefined && (updateType === 'text_delta' || updateType?.includes('thinking'))) {
      return { kind: 'text_delta', block: { kind: updateType === 'text_delta' ? 'assistant_text' : 'thinking', text: delta, index: typeof update?.contentIndex === 'number' ? update.contentIndex : 0 } }
    }
    return { kind: 'diagnostic', reason: 'unrenderable_message' }
  }
  if (type === 'message' || type === 'message_end') {
    if (message?.role === 'assistant') return { kind: 'assistant_message', blocks: assistantBlocks(message.content), error: modelCallError(message), reset: type === 'message' }
    if (user) return { kind: 'user', message: user }
    if (message?.role === 'toolResult') return { kind: 'tool', call: { id: string(message.toolCallId) ?? string(raw.toolCallId), name: string(message.toolName) ?? string(raw.toolName) } }
    return { kind: 'diagnostic', reason: 'unrenderable_message' }
  }
  if (type === 'message_start' && user) return { kind: 'user', message: user }
  if (type.startsWith('tool_execution_')) return { kind: 'tool', call: { id: string(raw.toolCallId), name: string(raw.toolName), arguments: record(raw.args) ?? record(raw.arguments) } }
  if (type.startsWith('bash_execution_')) return { kind: 'bash', ended: type === 'bash_execution_end', exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : undefined }
  if (type === 'auto_retry_start' || type === 'auto_retry_end') return { kind: 'retry', retrying: type === 'auto_retry_start' }
  if (type === 'file_change' || type === 'file_changes' || Array.isArray(raw.changes)) return { kind: 'file_change', changes: fileChanges(raw) }
  const metadata = ['context_edit', 'model_change', 'thinking_level_change', 'thinking_level_changed', 'turn_start', 'turn_end', 'agent_start', 'agent_end', 'agent_settled', 'aborted'].includes(type) || type.startsWith('compaction')
  return { kind: 'diagnostic', reason: metadata ? 'metadata' : 'unknown' }
}

export function readTimelineEvent(raw: Record<string, unknown>, id: string, observedAt: string): TimelineEvent {
  const type = string(raw.type) ?? 'unknown'
  const message = record(raw.message)
  const user = message?.role === 'user' ? userMessageView(message) : undefined
  const update = record(raw.assistantMessageEvent)
  const event: TimelineEvent = { raw, id, observedAt, nativeType: type, reading: reading(raw, type, message, user, update) }
  if (user) event.user = user
  if (message?.role === 'assistant') {
    event.assistant = { stopReason: string(message.stopReason) }
    if (type === 'message') event.branchable = true
  }
  if (type === 'message') event.historyMessage = true
  if (['turn_end', 'agent_end', 'agent_settled', 'aborted'].includes(type) || event.assistant?.stopReason !== undefined) event.completesTurn = true
  if (type === 'agent_settled') event.settledRun = true
  if (type === 'agent_settled' || type === 'aborted') event.settlement = type === 'aborted' || raw.aborted === true ? 'aborted' : 'finished'
  const updateType = string(update?.type)
  if (updateType && /^(thinking|text)_(start|delta|end)$/.test(updateType)) {
    event.phase = updateType === 'thinking_end' ? 'waiting' : updateType.startsWith('thinking_') ? 'thinking' : 'answering'
  }

  const endsTool = type === 'tool_execution_end'
  if (endsTool) event.endsTool = true
  const terminal = endsTool || message?.role === 'toolResult'
  const partial = record(raw.partialResult)
  const result = record(raw.result)
  const rootId = string(raw.toolCallId)
  const messageId = string(message?.toolCallId)
  const view = event.reading
  if (view.kind === 'tool' || view.kind === 'bash' || (view.kind === 'assistant_message' && view.blocks.some((block) => block.kind === 'tool'))) {
    event.activityText = activityText(raw)
  }
  if (view.kind === 'tool' || rootId !== undefined || messageId !== undefined || terminal || partial) {
    event.tool = {
      id: piToolCallId(raw, message), rootId, messageId, terminal, partial: !!partial,
      failed: raw.isError === true || (message ?? result)?.isError === true || !!raw.error,
      get output() { return terminal || partial ? toolOutput(message ?? result ?? partial, raw.error) : undefined },
    }
  }
  const planResult = message?.role === 'toolResult' ? message : endsTool ? result : undefined
  const details = record(planResult?.details)
  if (raw.isError !== true && planResult?.isError !== true && details?.source === 'plan_mode_complete' && details.version === 1 && typeof details.plan === 'string' && details.plan.trim()) {
    event.planCompletion = { text: details.plan, id: messageId ?? rootId ?? id }
  }
  const custom = type === 'custom_message' ? raw : message?.role === 'custom' ? message : undefined
  if (custom?.customType === 'proposed-plan' && custom.display !== false) event.proposedPlan = { text: messageText(custom.content) || undefined }
  return event
}

const runtimeEvents = new WeakMap<PiRuntimeEvent, TimelineEvent>()
export function runtimeTimelineEvent(event: PiRuntimeEvent) {
  let view = runtimeEvents.get(event)
  if (!view) {
    const { event: raw, ...runtime } = event
    view = readTimelineEvent(raw, `${event.sessionId}:${event.sequence}`, event.observedAt)
    view.runtime = runtime
    runtimeEvents.set(event, view)
  }
  return view
}

export type HistoryFileStatistics = { turnId: string; files: PiFileChange[]; incomplete: boolean }

export function historyTimelineEvent(entry: PiSessionHistoryEntry) {
  if (entry.type === 'custom' && entry.raw.customType === 'pi-nest-file-changes') {
    const data = record(entry.raw.data)
    const statistics: HistoryFileStatistics | undefined = data?.version === 1 && typeof data.turnId === 'string' && Array.isArray(data.files)
      ? { turnId: data.turnId, files: data.files.flatMap((file) => { const stats = fileChangeStatistics(file); return stats ? [stats] : [] }), incomplete: data.incomplete === true }
      : undefined
    return { kind: 'statistics' as const, statistics }
  }
  const event = readTimelineEvent(entry.raw, entry.id, entry.timestamp)
  return { kind: 'event' as const, event, startsTurn: entry.type === 'message' && event.user !== undefined }
}
