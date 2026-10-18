import { messageAttachments } from './session-run-model.js'
import type { AttachmentRef } from '@pi-nest/contracts'
import { modelCallError, type ModelCallError } from './model-call-error.js'
import type { RuntimeTurn } from './session-run-model.js'
import type { PiSessionHistoryEntry } from './history.js'
import type { PiRuntimeEvent } from './runtime-websocket-client.js'

export type { RuntimeTurn } from './session-run-model.js'

export type TurnTiming = {
  completedAt?: string
  startedAt: string
}

export type TimelineEvent = {
  event: Record<string, unknown>
  id: string
  observedAt: string
  raw: Record<string, unknown>
}

export type TimelineDiagnostic = {
  event: TimelineEvent
  reason: 'metadata' | 'unrenderable_message' | 'unknown'
}

export type TimelinePart =
  | { events: TimelineEvent[]; kind: 'assistant_text'; text: string }
  | { events: TimelineEvent[]; kind: 'bash' }
  | { events: TimelineEvent[]; kind: 'file_change' }
  | { events: TimelineEvent[]; kind: 'retry' }
  | { events: TimelineEvent[]; kind: 'thinking'; text: string }
  | { arguments?: Record<string, unknown>; events: TimelineEvent[]; kind: 'tool'; toolCallId: string | undefined; toolName: string }

export type TimelineItem = {
  attachmentWarning?: string
  attachments?: AttachmentRef[]
  steering?: RuntimeTurn['steering']
  plan?: { text: string; source: 'completion' | 'custom'; id: string }
  diagnostics: TimelineDiagnostic[]
  modelErrors?: ModelCallError[]
  displayId?: string
  events: TimelineEvent[]
  id: string
  kind: 'turn'
  parts: TimelinePart[]
  prompt: string | undefined
  runId?: string
  runIndex?: number
  runtimeTiming?: TurnTiming
  startedAt: string
}

export type TimelineNavigationEntry = {
  id: string
  index: number
  prompt: string
  promptPreview: string
  startedAt: string
}

const emptyHistory: PiSessionHistoryEntry[] = []
const emptyTimeline: TimelineItem[] = []
const historyItemCache = new WeakMap<PiSessionHistoryEntry[], TimelineItem[]>()
const timelineItemCache = new WeakMap<PiSessionHistoryEntry[], WeakMap<RuntimeTurn[], TimelineItem[]>>()
const navigationCache = new WeakMap<TimelineItem[], TimelineNavigationEntry[]>()
let previousNavigation: { entries: TimelineNavigationEntry[]; items: TimelineItem[] } | undefined

function record(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function textContent(content: unknown) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap((block) => {
    const candidate = record(block)
    return candidate?.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
  }).join('')
  return text || undefined
}

function eventType(event: TimelineEvent) {
  return typeof event.event.type === 'string' ? event.event.type : 'unknown'
}

function message(event: TimelineEvent) {
  return record(event.event.message)
}

function update(event: TimelineEvent) {
  return record(event.event.assistantMessageEvent)
}

const messageProjection = new WeakMap<TimelineItem, { index: number; started: boolean; blocks: Map<string, TimelinePart> }>()

function projectTextBlock(item: TimelineItem, kind: 'thinking' | 'assistant_text', event: TimelineEvent, text: string, contentIndex: number, delta: boolean) {
  const state = messageProjection.get(item)
  if (!state?.started) {
    if (delta) pushDelta(item.parts, kind, event, text)
    else if (kind === 'thinking') pushThinkingMessage(item.parts, event, text)
    else pushAssistantMessage(item.parts, event, text)
    return
  }
  const key = `${state.index}:${contentIndex}:${kind}`
  const previous = state.blocks.get(key)
  if (previous && 'text' in previous) {
    previous.text = delta ? previous.text + text : text
    previous.events.push(event)
  } else {
    const part: TimelinePart = { events: [event], kind, text }
    state.blocks.set(key, part)
    item.parts.push(part)
  }
}

function pushDelta(parts: TimelinePart[], kind: 'assistant_text' | 'thinking', event: TimelineEvent, text: string) {
  const previous = parts.at(-1)
  if (previous?.kind === kind) {
    previous.events.push(event)
    previous.text += text
    return
  }
  parts.push({ events: [event], kind, text })
}

function pushAssistantMessage(parts: TimelinePart[], event: TimelineEvent, text: string) {
  const previous = [...parts].reverse().find((part): part is Extract<TimelinePart, { kind: 'assistant_text' }> => part.kind === 'assistant_text')
  if (previous) {
    if (text === previous.text) {
      previous.events.push(event)
      return
    }
    if (text.startsWith(previous.text)) {
      previous.events.push(event)
      previous.text = text
      return
    }
  }
  parts.push({ events: [event], kind: 'assistant_text', text })
}

function pushThinkingMessage(parts: TimelinePart[], event: TimelineEvent, text: string) {
  const previous = [...parts].reverse().find((part) => part.kind === 'thinking')
  if (previous?.kind === 'thinking' && text.startsWith(previous.text)) {
    previous.text = text
    previous.events.push(event)
  } else parts.push({ events: [event], kind: 'thinking', text })
}

function pushTool(parts: TimelinePart[], event: TimelineEvent, toolCallId = typeof event.event.toolCallId === 'string' ? event.event.toolCallId : undefined, toolName = typeof event.event.toolName === 'string' ? event.event.toolName : '未知工具', arguments_: Record<string, unknown> | undefined = undefined) {
  const previous = [...parts].reverse().find((part) => part.kind === 'tool' && toolCallId !== undefined && part.toolCallId === toolCallId)
  if (previous?.kind === 'tool') {
    previous.events.push(event)
    if (arguments_) previous.arguments = arguments_
    if (toolName !== '未知工具') previous.toolName = toolName
    return
  }
  parts.push({ ...(arguments_ ? { arguments: arguments_ } : {}), events: [event], kind: 'tool', toolCallId, toolName })
}

function projectAssistantContent(item: TimelineItem, event: TimelineEvent, content: unknown) {
  if (typeof content === 'string') {
    if (!content) return false
    projectTextBlock(item, 'assistant_text', event, content, 0, false)
    return true
  }
  if (!Array.isArray(content)) return false
  let projected = false
  for (const [contentIndex, block] of content.entries()) {
    const candidate = record(block)
    if (candidate?.type === 'text' && typeof candidate.text === 'string') {
      projectTextBlock(item, 'assistant_text', event, candidate.text, contentIndex, false)
      projected = true
      continue
    }
    if (candidate?.type === 'thinking' && typeof candidate.thinking === 'string') {
      projectTextBlock(item, 'thinking', event, candidate.thinking, contentIndex, false)
      projected = true
      continue
    }
    if (candidate?.type === 'toolCall' && typeof candidate.id === 'string' && typeof candidate.name === 'string') {
      pushTool(item.parts, event, candidate.id, candidate.name, record(candidate.arguments))
      projected = true
    }
  }
  return projected
}

function pushActivity(parts: TimelinePart[], kind: 'bash' | 'file_change' | 'retry', event: TimelineEvent) {
  const previous = parts.at(-1)
  if (previous?.kind === kind) {
    previous.events.push(event)
    return
  }
  parts.push({ events: [event], kind })
}

function historyEvent(entry: PiSessionHistoryEntry): TimelineEvent {
  return { event: entry.raw, id: entry.id, observedAt: entry.timestamp, raw: entry.raw }
}

function runtimeEvent(event: PiRuntimeEvent): TimelineEvent {
  return { event: event.event, id: `${event.sessionId}:${event.sequence}`, observedAt: event.observedAt, raw: event.event }
}

function diagnostic(item: TimelineItem, event: TimelineEvent, reason: TimelineDiagnostic['reason']) {
  item.diagnostics.push({ event, reason })
}

function isMetadata(type: string) {
  return type === 'context_edit' || type === 'model_change' || type === 'thinking_level_change' || type === 'thinking_level_changed' || type.startsWith('compaction') || type === 'turn_start' || type === 'turn_end' || type === 'agent_start' || type === 'agent_end' || type === 'agent_settled' || type === 'aborted'
}

function projectEvent(item: TimelineItem, event: TimelineEvent) {
  item.events.push(event)
  const type = eventType(event)
  const native = message(event)
  const result = native?.role === 'toolResult' ? native : type === 'tool_execution_end' ? record(event.event.result) : undefined
  const details = record(result?.details)
  if (event.event.isError !== true && result?.isError !== true && details?.source === 'plan_mode_complete' && details.version === 1 && typeof details.plan === 'string' && details.plan.trim()) {
    item.plan = { text: details.plan, source: 'completion', id: typeof native?.toolCallId === 'string' ? native.toolCallId : typeof event.event.toolCallId === 'string' ? event.event.toolCallId : event.id }
  }
  const custom = type === 'custom_message' ? event.event : native?.role === 'custom' ? native : undefined
  if (custom?.customType === 'proposed-plan' && custom.display !== false && item.plan?.source !== 'completion') {
    const plan = textContent(custom.content)
    if (plan?.trim()) item.plan = { text: plan, source: 'custom', id: event.id }
    return
  }
  const assistantUpdate = update(event)
  if (type === 'message_start' && message(event)?.role === 'assistant') {
    const previous = messageProjection.get(item)
    messageProjection.set(item, { blocks: previous?.blocks ?? new Map(), index: (previous?.index ?? -1) + 1, started: true })
    return
  }
  if (type === 'message' && message(event)?.role === 'assistant') {
    const previous = messageProjection.get(item)
    if (previous?.started) previous.started = false
  }
  if (type === 'message_update' && assistantUpdate?.type === 'text_delta' && typeof assistantUpdate.delta === 'string') {
    projectTextBlock(item, 'assistant_text', event, assistantUpdate.delta, typeof assistantUpdate.contentIndex === 'number' ? assistantUpdate.contentIndex : 0, true)
    return
  }
  if (type === 'message_update' && typeof assistantUpdate?.type === 'string' && assistantUpdate.type.includes('thinking') && typeof assistantUpdate.delta === 'string') {
    projectTextBlock(item, 'thinking', event, assistantUpdate.delta, typeof assistantUpdate.contentIndex === 'number' ? assistantUpdate.contentIndex : 0, true)
    return
  }
  if (type === 'message_update') return diagnostic(item, event, 'unrenderable_message')

  const nativeMessage = message(event)
  if ((type === 'message' || type === 'message_end') && nativeMessage?.role === 'assistant') {
    const error = modelCallError(nativeMessage)
    if (error && !item.modelErrors?.some((saved) => saved.message === error.message && saved.model === error.model && saved.provider === error.provider)) (item.modelErrors ??= []).push(error)
    if (projectAssistantContent(item, event, nativeMessage.content) || error) return
    return diagnostic(item, event, 'unrenderable_message')
  }
  if ((type === 'message' || type === 'message_start' || type === 'message_end') && nativeMessage?.role === 'user') {
    if (typeof nativeMessage.piNestAttachmentWarning === 'string') item.attachmentWarning = nativeMessage.piNestAttachmentWarning
    const attachments = messageAttachments(nativeMessage)
    if (item.attachments?.length && attachments.length !== item.attachments.length) item.attachmentWarning = 'Pi 实际记录的附件与提交不一致，请检查模型或扩展。'
    if (attachments.length || item.attachments) item.attachments = attachments
    return
  }
  if ((type === 'message' || type === 'message_end') && nativeMessage?.role === 'toolResult') {
    const toolCallId = typeof nativeMessage.toolCallId === 'string' ? nativeMessage.toolCallId : undefined
    const toolName = typeof nativeMessage.toolName === 'string' ? nativeMessage.toolName : '未知工具'
    return pushTool(item.parts, event, toolCallId, toolName)
  }
  if (type === 'message' || type === 'message_end') return diagnostic(item, event, 'unrenderable_message')
  if (type.startsWith('tool_execution_')) return pushTool(item.parts, event, undefined, undefined, record(event.event.args) ?? record(event.event.arguments))
  if (type.startsWith('bash_execution_')) return pushActivity(item.parts, 'bash', event)
  if (type === 'auto_retry_start' || type === 'auto_retry_end') return pushActivity(item.parts, 'retry', event)
  if (type === 'file_change' || type === 'file_changes' || Array.isArray(event.event.changes)) return pushActivity(item.parts, 'file_change', event)
  if (isMetadata(type)) return diagnostic(item, event, 'metadata')
  diagnostic(item, event, 'unknown')
}

function newTurn(id: string, prompt: string | undefined, startedAt: string, runtimeTiming?: TurnTiming): TimelineItem {
  return { diagnostics: [], events: [], id, kind: 'turn', parts: [], prompt, ...(runtimeTiming ? { runtimeTiming } : {}), startedAt }
}

function historyItems(entries: PiSessionHistoryEntry[]): TimelineItem[] {
  const items: TimelineItem[] = []
  let active: TimelineItem | undefined
  for (const entry of entries) {
    const event = historyEvent(entry)
    const nativeMessage = message(event)
    if (entry.type === 'message' && nativeMessage?.role === 'user') {
      if (active) items.push(active)
      active = newTurn(entry.id, textContent(nativeMessage.content) ?? (messageAttachments(nativeMessage).length ? '图片附件' : undefined), entry.timestamp)
      active.runId = entry.runId
      active.runIndex = entry.runIndex
      projectEvent(active, event)
      continue
    }
    if (active) projectEvent(active, event)
  }
  if (active) items.push(active)
  return items
}

function memoizedHistoryItems(entries: PiSessionHistoryEntry[]) {
  const cached = historyItemCache.get(entries)
  if (cached) return cached
  const items = historyItems(entries)
  historyItemCache.set(entries, items)
  return items
}

export function timelineItems(history: PiSessionHistoryEntry[] | undefined, turns: RuntimeTurn[], _systemEvents: PiRuntimeEvent[]): TimelineItem[] {
  const historyKey = history ?? emptyHistory
  let cachedForHistory = timelineItemCache.get(historyKey)
  if (!cachedForHistory) {
    cachedForHistory = new WeakMap()
    timelineItemCache.set(historyKey, cachedForHistory)
  }
  const cached = cachedForHistory.get(turns)
  if (cached) return cached

  const historyProjection = history ? memoizedHistoryItems(history) : emptyTimeline
  const items: TimelineItem[] = turns.length > 0 ? [...historyProjection] : historyProjection
  const matchedHistory = new Set<string>()
  for (const turn of turns) {
    // A local turn exists only after an explicit user prompt has been accepted.
    // Runtime events may enrich it, but cannot create another conversation node.
    if (!turn.prompt?.trim() && !turn.attachments?.length) continue
    const runtimeTiming = { ...(turn.completedAt === undefined ? {} : { completedAt: turn.completedAt }), startedAt: turn.executionStartedAt ?? turn.startedAt }
    const nativeUser = turn.events.find((event) => record(event.event.message)?.role === 'user')
    const nativeId = record(nativeUser?.event.message)?.id
    const nativePrompt = textContent(record(nativeUser?.event.message)?.content)
    const anchorIndex = historyProjection.findIndex((item) => item.id === turn.historyAnchorId)
    const runId = turn.runId ?? turn.events.find((event) => event.runId)?.runId
    const runIndex = turns.slice(0, turns.indexOf(turn)).filter((previous) => (previous.runId ?? previous.events.find((event) => event.runId)?.runId) === runId && (!previous.steering || previous.steering.status === 'applied')).length
    const persisted = historyProjection.find((item, index) => {
      if (turn.steering?.status === 'failed' || turn.steering?.status === 'sending') return false
      if (matchedHistory.has(item.id)) return false
      if (typeof nativeId === 'string') return item.id === nativeId
      if (runId) return item.runId === runId && item.runIndex === runIndex
      if (item.prompt !== (nativePrompt ?? turn.prompt)) return false
      // The submission boundary survives pagination and repeated identical prompts.
      if (turn.historyAnchorId && anchorIndex >= 0) return index > anchorIndex
      return Date.parse(item.startedAt) >= Date.parse(turn.submittedAt ?? turn.startedAt) - 2_000
    })
    const item = newTurn(persisted?.id ?? turn.id, turn.prompt ?? promptFrom(turn.events), persisted?.startedAt ?? turn.startedAt, runtimeTiming)
    item.attachments = turn.attachments ?? persisted?.attachments
    item.displayId = `${turn.id}:${turn.submittedAt ?? turn.startedAt}`
    item.steering = turn.steering ? { ...turn.steering, ...(persisted ? { status: 'applied' as const } : {}) } : undefined
    for (const event of turn.events) projectEvent(item, runtimeEvent(event))
    if (persisted) {
      matchedHistory.add(persisted.id)
      item.modelErrors ??= persisted.modelErrors
      item.plan ??= persisted.plan
      let savedIndex = 0
      const covered = (!item.plan || item.plan.text === persisted.plan?.text) && (item.modelErrors ?? []).every((error) => persisted.modelErrors?.some((saved) => saved.message === error.message && saved.model === error.model && saved.provider === error.provider)) && item.parts.every((part) => {
        const index = persisted.parts.findIndex((saved, index) => {
          if (index < savedIndex) return false
          if (part.kind !== saved.kind) return false
          if ('text' in part && 'text' in saved) return saved.text === part.text
          if (part.kind === 'tool' && saved.kind === 'tool') return part.toolCallId === saved.toolCallId && toolStatus(part.events) === toolStatus(saved.events)
          return false
        })
        if (index < 0) return false
        savedIndex = index + 1
        return true
      })
      // A user entry or an intermediate message_end is not a completed response.
      if (turn.completedAt && covered && (persisted.parts.length > 0 || (persisted.modelErrors?.length ?? 0) > 0 || persisted.events.some((event) => eventType(event) === 'agent_settled'))) {
        items[items.indexOf(persisted)] = { ...persisted, displayId: item.displayId, steering: item.steering }
      } else {
        if (item.parts.length === 0) item.parts = persisted.parts
        items[items.indexOf(persisted)] = item
      }
    } else {
      const index = items.findIndex((saved) => Date.parse(saved.startedAt) > Date.parse(item.startedAt))
      if (index < 0) items.push(item)
      else items.splice(index, 0, item)
    }
  }
  cachedForHistory.set(turns, items)
  return items
}

export function timelineNavigationEntries(items: TimelineItem[]): TimelineNavigationEntry[] {
  const cached = navigationCache.get(items)
  if (cached) return cached
  if (previousNavigation && items.length === previousNavigation.items.length && items.every((item, index) => {
    const entry = previousNavigation!.entries[index]
    return entry?.id === item.id && entry.prompt === (item.prompt ?? '') && entry.startedAt === item.startedAt
  })) {
    navigationCache.set(items, previousNavigation.entries)
    return previousNavigation.entries
  }
  const entries = items.map((item, index) => ({
    id: item.id,
    index: index + 1,
    prompt: item.prompt ?? '',
    promptPreview: navigationPreview(item.prompt),
    startedAt: item.startedAt,
  }))
  navigationCache.set(items, entries)
  previousNavigation = { entries, items }
  return entries
}

function navigationPreview(prompt: string | undefined) {
  if (!prompt) return '无用户正文'
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim())
  return (firstLine ?? prompt).replace(/\s+/g, ' ').trim().slice(0, 96) || '无用户正文'
}

function promptFrom(events: PiRuntimeEvent[]) {
  for (const event of events) {
    const candidate = record(event.event.message)
    if (candidate?.role === 'user') return textContent(candidate.content)
  }
  return undefined
}

export function diagnosticLabel(diagnostic: TimelineDiagnostic) {
  const type = eventType(diagnostic.event)
  if (diagnostic.reason === 'metadata') return `运行元数据：${type}`
  if (diagnostic.reason === 'unrenderable_message') return `未展示的消息记录：${type}`
  return `未识别的 Pi 事件：${type}`
}

export function rawJson(events: TimelineEvent[]) {
  return JSON.stringify(events.map(({ raw }) => raw), null, 2)
}

export function toolStatus(events: TimelineEvent[]) {
  const terminal = events.findLast((event) => eventType(event) === 'tool_execution_end' || record(event.event.message)?.role === 'toolResult')
  if (!terminal) return '正在执行'
  const result = record(terminal.event.message) ?? record(terminal.event.result)
  return terminal.event.isError === true || result?.isError === true || terminal.event.error ? '失败' : '完成'
}

export function duration(events: TimelineEvent[]) {
  if (events.some((event) => eventType(event) === 'message')) return undefined
  if (events.length < 2) return undefined
  const start = Date.parse(events[0]!.observedAt)
  const end = Date.parse(events.at(-1)!.observedAt)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined
}
