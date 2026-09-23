import type { PiSessionHistoryEntry } from './history.js'
import type { PiRuntimeEvent } from './runtime-websocket-client.js'

export type RuntimeTurn = {
  events: PiRuntimeEvent[]
  id: string
  prompt?: string
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
  | { events: TimelineEvent[]; kind: 'thinking'; text: string }
  | { events: TimelineEvent[]; kind: 'tool'; toolCallId: string | undefined; toolName: string }

export type TimelineItem = {
  diagnostics: TimelineDiagnostic[]
  events: TimelineEvent[]
  id: string
  kind: 'turn'
  parts: TimelinePart[]
  prompt: string | undefined
  startedAt: string
}

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

function pushTool(parts: TimelinePart[], event: TimelineEvent) {
  const toolCallId = typeof event.event.toolCallId === 'string' ? event.event.toolCallId : undefined
  const toolName = typeof event.event.toolName === 'string' ? event.event.toolName : '未知工具'
  const previous = [...parts].reverse().find((part) => part.kind === 'tool' && part.toolCallId === toolCallId && part.toolName === toolName)
  if (previous?.kind === 'tool') {
    previous.events.push(event)
    return
  }
  parts.push({ events: [event], kind: 'tool', toolCallId, toolName })
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
  return type === 'model_change' || type === 'thinking_level_change' || type === 'thinking_level_changed' || type.startsWith('compaction') || type === 'turn_start' || type === 'turn_end' || type === 'agent_start' || type === 'agent_end' || type === 'agent_settled' || type === 'aborted' || type === 'message_end'
}

function projectEvent(item: TimelineItem, event: TimelineEvent) {
  item.events.push(event)
  const type = eventType(event)
  const assistantUpdate = update(event)
  if (type === 'message_update' && assistantUpdate?.type === 'text_delta' && typeof assistantUpdate.delta === 'string') {
    pushDelta(item.parts, 'assistant_text', event, assistantUpdate.delta)
    return
  }
  if (type === 'message_update' && typeof assistantUpdate?.type === 'string' && assistantUpdate.type.includes('thinking') && typeof assistantUpdate.delta === 'string') {
    pushDelta(item.parts, 'thinking', event, assistantUpdate.delta)
    return
  }
  if (type === 'message_update') return diagnostic(item, event, 'unrenderable_message')

  const nativeMessage = message(event)
  if (type === 'message' && nativeMessage?.role === 'assistant') {
    const text = textContent(nativeMessage.content)
    if (text) return pushAssistantMessage(item.parts, event, text)
    return diagnostic(item, event, 'unrenderable_message')
  }
  if (type === 'message' && nativeMessage?.role === 'user') return
  if (type === 'message') return diagnostic(item, event, 'unrenderable_message')
  if (type.startsWith('tool_execution_')) return pushTool(item.parts, event)
  if (type.startsWith('bash_execution_')) return item.parts.push({ events: [event], kind: 'bash' })
  if (type === 'file_change' || type === 'file_changes' || Array.isArray(event.event.changes)) return item.parts.push({ events: [event], kind: 'file_change' })
  if (isMetadata(type)) return diagnostic(item, event, 'metadata')
  diagnostic(item, event, 'unknown')
}

function newTurn(id: string, prompt: string | undefined, startedAt: string): TimelineItem {
  return { diagnostics: [], events: [], id, kind: 'turn', parts: [], prompt, startedAt }
}

function historyItems(entries: PiSessionHistoryEntry[]): TimelineItem[] {
  const items: TimelineItem[] = []
  let active: TimelineItem | undefined
  for (const entry of entries) {
    const event = historyEvent(entry)
    const nativeMessage = message(event)
    if (entry.type === 'message' && nativeMessage?.role === 'user') {
      if (active) items.push(active)
      active = newTurn(entry.id, textContent(nativeMessage.content), entry.timestamp)
      projectEvent(active, event)
      continue
    }
    if (active) projectEvent(active, event)
  }
  if (active) items.push(active)
  return items
}

export function timelineItems(history: PiSessionHistoryEntry[] | undefined, turns: RuntimeTurn[], _systemEvents: PiRuntimeEvent[]): TimelineItem[] {
  if (history) return historyItems(history)
  return turns.map((turn) => {
    const item = newTurn(turn.id, turn.prompt ?? promptFrom(turn.events), turn.startedAt)
    for (const event of turn.events) projectEvent(item, runtimeEvent(event))
    return item
  })
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
  const end = events.find((event) => eventType(event) === 'tool_execution_end')
  if (!end) return '正在执行'
  return end.event.isError === true || end.event.error ? '失败' : '完成'
}

export function duration(events: TimelineEvent[]) {
  if (events.length < 2) return undefined
  const start = Date.parse(events[0]!.observedAt)
  const end = Date.parse(events.at(-1)!.observedAt)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined
}
