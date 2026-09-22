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

export type TimelinePart =
  | { events: TimelineEvent[]; kind: 'assistant_text'; text: string }
  | { events: TimelineEvent[]; kind: 'bash' }
  | { events: TimelineEvent[]; kind: 'file_change' }
  | { events: TimelineEvent[]; kind: 'native' }
  | { events: TimelineEvent[]; kind: 'system' }
  | { events: TimelineEvent[]; kind: 'thinking'; text: string }
  | { events: TimelineEvent[]; kind: 'tool'; toolCallId: string | undefined; toolName: string }

export type TimelineItem =
  | { id: string; kind: 'system'; part: TimelinePart }
  | { id: string; kind: 'turn'; parts: TimelinePart[]; prompt: string | undefined; startedAt: string }

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

function pushText(parts: TimelinePart[], kind: 'assistant_text' | 'thinking', event: TimelineEvent, text: string) {
  const previous = parts.at(-1)
  if (previous?.kind === kind) {
    previous.events.push(event)
    previous.text += text
    return
  }
  parts.push({ events: [event], kind, text })
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

function partFor(event: TimelineEvent, parts: TimelinePart[]) {
  const type = eventType(event)
  const assistantUpdate = update(event)
  if (type === 'message_update' && assistantUpdate?.type === 'text_delta' && typeof assistantUpdate.delta === 'string') {
    pushText(parts, 'assistant_text', event, assistantUpdate.delta)
    return
  }
  if (type === 'message_update' && typeof assistantUpdate?.type === 'string' && assistantUpdate.type.includes('thinking') && typeof assistantUpdate.delta === 'string') {
    pushText(parts, 'thinking', event, assistantUpdate.delta)
    return
  }
  const nativeMessage = message(event)
  if (type === 'message' && nativeMessage?.role === 'assistant') {
    const text = textContent(nativeMessage.content)
    if (text) {
      pushText(parts, 'assistant_text', event, text)
      return
    }
  }
  if (type.startsWith('tool_execution_')) return pushTool(parts, event)
  if (type.startsWith('bash_execution_')) return parts.push({ events: [event], kind: 'bash' })
  if (type === 'file_change' || type === 'file_changes' || Array.isArray(event.event.changes)) return parts.push({ events: [event], kind: 'file_change' })
  if (type === 'model_change' || type === 'thinking_level_change' || type === 'thinking_level_changed' || type.startsWith('compaction') || type === 'turn_start' || type === 'turn_end' || type === 'agent_start' || type === 'agent_end' || type === 'agent_settled' || type === 'aborted') {
    return parts.push({ events: [event], kind: 'system' })
  }
  parts.push({ events: [event], kind: 'native' })
}

function historyItems(entries: PiSessionHistoryEntry[]): TimelineItem[] {
  const items: TimelineItem[] = []
  let active: Extract<TimelineItem, { kind: 'turn' }> | undefined
  for (const entry of entries) {
    const event = historyEvent(entry)
    const nativeMessage = message(event)
    if (entry.type === 'message' && nativeMessage?.role === 'user') {
      if (active) items.push(active)
      active = { id: entry.id, kind: 'turn', parts: [], prompt: textContent(nativeMessage.content), startedAt: entry.timestamp }
      continue
    }
    if (active) partFor(event, active.parts)
    else items.push({ id: entry.id, kind: 'system', part: partFrom(event) })
  }
  if (active) items.push(active)
  return items
}

function partFrom(event: TimelineEvent) {
  const parts: TimelinePart[] = []
  partFor(event, parts)
  return parts[0] ?? { events: [event], kind: 'native' }
}

export function timelineItems(history: PiSessionHistoryEntry[] | undefined, turns: RuntimeTurn[], systemEvents: PiRuntimeEvent[]) {
  if (history) return historyItems(history)
  const runtimeItems = turns.map((turn) => {
    const parts: TimelinePart[] = []
    for (const event of turn.events) partFor(runtimeEvent(event), parts)
    return {
      item: { id: turn.id, kind: 'turn' as const, parts, prompt: turn.prompt ?? promptFrom(turn.events), startedAt: turn.startedAt },
      sequence: turn.events[0]?.sequence ?? Number.MAX_SAFE_INTEGER,
    }
  })
  return [
    ...systemEvents.map((event) => ({
      item: { id: `${event.sessionId}:${event.sequence}`, kind: 'system' as const, part: partFrom(runtimeEvent(event)) },
      sequence: event.sequence,
    })),
    ...runtimeItems,
  ].sort((left, right) => left.sequence - right.sequence).map(({ item }) => item)
}

function promptFrom(events: PiRuntimeEvent[]) {
  for (const event of events) {
    const candidate = record(event.event.message)
    if (candidate?.role === 'user') return textContent(candidate.content)
  }
  return undefined
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
