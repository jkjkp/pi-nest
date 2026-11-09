import type { AttachmentRef, PiFileChange } from '@pi-nest/contracts'
import type { ModelCallError } from './model-call-error.js'
import { historyTimelineEvent, runtimeTimelineEvent, type HistoryFileStatistics, type TimelineEvent } from './timeline-event.js'
import type { RuntimeTurn } from './session-run-model.js'
import type { PiSessionHistoryEntry } from './history.js'
import type { PiRuntimeEvent } from './runtime-websocket-client.js'

export type { RuntimeTurn } from './session-run-model.js'

export type TurnTiming = {
  completedAt?: string
  startedAt: string
}

export type { TimelineEvent } from './timeline-event.js'

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
  fileChanges?: PiFileChange[]
  fileChangesIncomplete?: boolean
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
const runtimeItemCache = new WeakMap<RuntimeTurn, { item: TimelineItem; userMessages: NonNullable<TimelineEvent['user']>[] }>()
const historyItemCache = new WeakMap<PiSessionHistoryEntry[], TimelineItem[]>()
const timelineItemCache = new WeakMap<PiSessionHistoryEntry[], WeakMap<RuntimeTurn[], TimelineItem[]>>()
const navigationCache = new WeakMap<TimelineItem[], TimelineNavigationEntry[]>()
let previousNavigation: { entries: TimelineNavigationEntry[]; items: TimelineItem[] } | undefined

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

function pushTool(parts: TimelinePart[], event: TimelineEvent, { id: toolCallId, name: toolName = '未知工具', arguments: arguments_ }: { id?: string; name?: string; arguments?: Record<string, unknown> }) {
  const previous = [...parts].reverse().find((part) => part.kind === 'tool' && toolCallId !== undefined && part.toolCallId === toolCallId)
  if (previous?.kind === 'tool') {
    previous.events.push(event)
    if (arguments_) previous.arguments = arguments_
    if (toolName !== '未知工具') previous.toolName = toolName
    return
  }
  parts.push({ ...(arguments_ ? { arguments: arguments_ } : {}), events: [event], kind: 'tool', toolCallId, toolName })
}

function pushActivity(parts: TimelinePart[], kind: 'bash' | 'file_change' | 'retry', event: TimelineEvent) {
  const previous = parts.at(-1)
  if (previous?.kind === kind) {
    previous.events.push(event)
    return
  }
  parts.push({ events: [event], kind })
}

function diagnostic(item: TimelineItem, event: TimelineEvent, reason: TimelineDiagnostic['reason']) {
  item.diagnostics.push({ event, reason })
}

function projectUserAttachments(item: TimelineItem, { attachments, warning }: NonNullable<TimelineEvent['user']>) {
  if (warning !== undefined) item.attachmentWarning = warning
  if (item.attachments?.length && attachments.length !== item.attachments.length) item.attachmentWarning = 'Pi 实际记录的附件与提交不一致，请检查模型或扩展。'
  if (attachments.length || item.attachments) item.attachments = attachments
}

function projectEvent(item: TimelineItem, event: TimelineEvent) {
  item.events.push(event)
  if (event.planCompletion) item.plan = { ...event.planCompletion, source: 'completion' }
  if (event.proposedPlan && item.plan?.source !== 'completion') {
    if (event.proposedPlan.text?.trim()) item.plan = { text: event.proposedPlan.text, source: 'custom', id: event.id }
    return
  }
  const view = event.reading
  switch (view.kind) {
    case 'assistant_started': {
      const previous = messageProjection.get(item)
      messageProjection.set(item, { blocks: previous?.blocks ?? new Map(), index: (previous?.index ?? -1) + 1, started: true })
      break
    }
    case 'assistant_message': {
      const previous = messageProjection.get(item)
      if (view.reset && previous?.started) previous.started = false
      const error = view.error
      if (error && !item.modelErrors?.some((saved) => saved.message === error.message && saved.model === error.model && saved.provider === error.provider)) (item.modelErrors ??= []).push(error)
      for (const block of view.blocks) {
        if (block.kind === 'tool') pushTool(item.parts, event, block)
        else projectTextBlock(item, block.kind, event, block.text, block.index, false)
      }
      if (!view.blocks.length && !error) diagnostic(item, event, 'unrenderable_message')
      break
    }
    case 'text_delta': {
      const { kind, text, index } = view.block
      projectTextBlock(item, kind, event, text, index, true)
      break
    }
    case 'user': projectUserAttachments(item, view.message); break
    case 'tool': pushTool(item.parts, event, view.call); break
    case 'bash':
    case 'retry':
    case 'file_change': pushActivity(item.parts, view.kind, event); break
    case 'diagnostic': diagnostic(item, event, view.reason); break
  }
}

function newTurn(id: string, prompt: string | undefined, startedAt: string, runtimeTiming?: TurnTiming): TimelineItem {
  return { diagnostics: [], events: [], id, kind: 'turn', parts: [], prompt, ...(runtimeTiming ? { runtimeTiming } : {}), startedAt }
}

function historyItems(entries: PiSessionHistoryEntry[]): TimelineItem[] {
  const items: TimelineItem[] = []
  let active: TimelineItem | undefined
  const fileStatistics: HistoryFileStatistics[] = []
  for (const entry of entries) {
    const decoded = historyTimelineEvent(entry)
    if (decoded.kind === 'statistics') {
      if (decoded.statistics) fileStatistics.push(decoded.statistics)
      continue
    }
    const { event } = decoded
    if (decoded.startsTurn && event.user) {
      if (active) items.push(active)
      active = newTurn(entry.id, event.user.text ?? (event.user.attachments.length ? '图片附件' : undefined), entry.timestamp)
      active.runId = entry.runId
      active.runIndex = entry.runIndex
    }
    if (active) projectEvent(active, event)
  }
  if (active) items.push(active)
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const data of fileStatistics) {
    const target = byId.get(data.turnId)
    if (target) {
      target.fileChanges = data.files
      target.fileChangesIncomplete = data.incomplete
    }
  }
  return items
}

function memoizedHistoryItems(entries: PiSessionHistoryEntry[]) {
  const cached = historyItemCache.get(entries)
  if (cached) return cached
  const items = historyItems(entries)
  historyItemCache.set(entries, items)
  return items
}

function runtimeItem(turn: RuntimeTurn) {
  const cached = runtimeItemCache.get(turn)
  if (cached) return cached
  const events = turn.events.map(runtimeTimelineEvent)
  const item = newTurn(turn.id, turn.prompt ?? events.find((event) => event.user)?.user?.text, turn.startedAt)
  const userMessages: NonNullable<TimelineEvent['user']>[] = []
  for (const event of events) {
    projectEvent(item, event)
    if (event.reading.kind === 'user') userMessages.push(event.reading.message)
  }
  const projection = { item, userMessages }
  runtimeItemCache.set(turn, projection)
  return projection
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
    const projection = runtimeItem(turn)
    const nativeUser = projection.item.events.find((event) => event.user)?.user
    const nativeId = nativeUser?.id
    const nativePrompt = nativeUser?.text
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
    // History-dependent fields belong to this merge, not the shared event projection.
    const item: TimelineItem = { ...projection.item, id: persisted?.id ?? turn.id, startedAt: persisted?.startedAt ?? turn.startedAt, runtimeTiming, attachmentWarning: undefined }
    item.fileChanges = persisted?.fileChanges
    item.fileChangesIncomplete = persisted?.fileChangesIncomplete
    item.attachments = turn.attachments ?? persisted?.attachments
    item.displayId = `${turn.id}:${turn.submittedAt ?? turn.startedAt}`
    item.steering = turn.steering ? { ...turn.steering, ...(persisted ? { status: 'applied' as const } : {}) } : undefined
    for (const native of projection.userMessages) projectUserAttachments(item, native)
    if (persisted) {
      matchedHistory.add(persisted.id)
      item.modelErrors ??= persisted.modelErrors
      item.plan ??= persisted.plan
      if (persisted.diagnostics.length) item.diagnostics = item.diagnostics.length ? [...persisted.diagnostics, ...item.diagnostics] : persisted.diagnostics
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
      if (turn.completedAt && covered && (persisted.parts.length > 0 || (persisted.modelErrors?.length ?? 0) > 0 || persisted.events.some((event) => event.settledRun))) {
        items[items.indexOf(persisted)] = { ...persisted, diagnostics: item.diagnostics, displayId: item.displayId, steering: item.steering }
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

export function diagnosticLabel(diagnostic: TimelineDiagnostic) {
  const type = diagnostic.event.nativeType
  if (diagnostic.reason === 'metadata') return `运行元数据：${type}`
  if (diagnostic.reason === 'unrenderable_message') return `未展示的消息记录：${type}`
  return `未识别的 Pi 事件：${type}`
}

export function toolStatus(events: TimelineEvent[]) {
  const terminal = events.findLast((event) => event.tool?.terminal)
  return terminal ? terminal.tool!.failed ? '失败' : '完成' : '正在执行'
}

export function duration(events: TimelineEvent[]) {
  if (events.some((event) => event.historyMessage)) return undefined
  if (events.length < 2) return undefined
  const start = Date.parse(events[0]!.observedAt)
  const end = Date.parse(events.at(-1)!.observedAt)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined
}
