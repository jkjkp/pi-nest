import { expect, it, vi } from 'vitest'
import type { PiRuntimeEvent } from '@pi-nest/contracts'
import type { RuntimeTurn } from './session-run-model.js'
import type { PiSessionHistoryEntry } from './history.js'
import { timelineItems, toolStatus } from './timeline-model.js'

const timestamp = '2026-10-28T00:00:00Z'
const event = (sequence: number, raw: Record<string, unknown>): PiRuntimeEvent => ({ sessionId: 'session', sequence, observedAt: timestamp, event: raw })
const turn = (id: string, events: PiRuntimeEvent[]): RuntimeTurn => ({ id, prompt: id, startedAt: timestamp, events })
const history = (id: string, prompt: string, answer: string): PiSessionHistoryEntry[] => [
  { id, parentId: null, timestamp, type: 'message', raw: { type: 'message', message: { role: 'user', content: prompt } } },
  { id: `${id}-answer`, parentId: id, timestamp, type: 'message', raw: { type: 'message', message: { role: 'assistant', content: answer } } },
]
function trackedDelta(text: string) {
  const project = vi.fn(() => ({ type: 'text_delta', delta: text }))
  return { project, event: event(1, { type: 'message_update', get assistantMessageEvent() { return project() } }) }
}

it('does not project unchanged completed turns when the active turn receives an event', () => {
  const saved = trackedDelta('saved')
  const complete = { ...turn('saved', [saved.event]), completedAt: timestamp }
  const active = turn('active', [event(2, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'one' } })])
  const initial = timelineItems(undefined, [complete, active], [])
  Object.freeze(initial[0]!.parts)
  for (const part of initial[0]!.parts) { Object.freeze(part.events); Object.freeze(part) }
  Object.freeze(initial[0]!.events)
  Object.freeze(initial[0]!.diagnostics)
  saved.project.mockClear()
  const streamed = timelineItems(undefined, [complete, { ...active, events: [...active.events, event(3, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'two' } })] }], [])
  expect(saved.project).not.toHaveBeenCalled()
  expect(streamed[0]!.parts).toBe(initial[0]!.parts)
  expect(streamed[1]!.parts).toMatchObject([{ text: 'onetwo' }])
  expect(initial[1]!.parts).toMatchObject([{ text: 'one' }])
})

it('reprojects a completed turn replaced after a legitimate late event', () => {
  const saved = trackedDelta('one')
  const complete = { ...turn('saved', [saved.event]), completedAt: timestamp }
  timelineItems(undefined, [complete], [])
  saved.project.mockClear()
  const updated = { ...complete, events: [...complete.events, event(2, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'two' } })] }
  expect(timelineItems(undefined, [updated], [])[0]!.parts).toMatchObject([{ text: 'onetwo' }])
  expect(saved.project).toHaveBeenCalledTimes(1)
})

it('rematches refreshed and prepended history without reprojecting the unchanged turn', () => {
  const saved = trackedDelta('answer')
  const live = turn('prompt', [saved.event])
  timelineItems(undefined, [live], [])
  saved.project.mockClear()
  const latest = history('native', 'prompt', 'answer')
  expect(timelineItems(latest, [live], []).map((item) => item.id)).toEqual(['native'])
  expect(timelineItems([...history('earlier', 'earlier', 'earlier'), ...latest], [live], []).map((item) => item.id)).toEqual(['earlier', 'native'])
  expect(saved.project).not.toHaveBeenCalled()
  const complete = { ...live, completedAt: timestamp }
  expect(timelineItems(latest, [complete], [])[0]!.id).toBe('native')
})

it('does not retain historical parts, plans or errors in a shared runtime projection', () => {
  const live = turn('prompt', [event(1, { type: 'turn_start' })])
  const persisted = history('native', 'prompt', 'historical answer')
  persisted.push({ id: 'plan', parentId: null, timestamp, type: 'message', raw: { type: 'message', message: { role: 'custom', customType: 'proposed-plan', content: 'historical plan' } } })
  persisted.push({ id: 'error', parentId: null, timestamp, type: 'message', raw: { type: 'message', message: { role: 'assistant', stopReason: 'error', errorMessage: 'historical error' } } })
  const first = timelineItems(persisted, [live], [])[0]!
  expect(first.parts).toMatchObject([{ text: 'historical answer' }])
  expect(first.plan?.text).toBe('historical plan')
  expect(first.modelErrors).toHaveLength(1)
  const clean = timelineItems(undefined, [live], [])[0]!
  expect(clean.parts).toEqual([])
  expect(clean.plan).toBeUndefined()
  expect(clean.modelErrors).toBeUndefined()
  expect(timelineItems(history('different', 'prompt', 'different answer'), [live], [])[0]!.parts).toMatchObject([{ text: 'different answer' }])
})

it('keeps cached and cold text, tools, attachments, plans, errors and diagnostics identical', () => {
  const attachment = { id: 'a'.repeat(64), kind: 'image' as const, name: 'image', size: 100, mediaType: 'image/png' }
  const live = { ...turn('prompt', [
    event(1, { type: 'message_start', message: { role: 'user', content: [{ type: 'image', attachment }] } }),
    event(2, { type: 'message_start', message: { role: 'assistant' } }),
    event(3, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } }),
    event(4, { type: 'tool_execution_start', toolCallId: 'call', toolName: 'read' }),
    event(5, { type: 'tool_execution_end', toolCallId: 'call', result: { details: { source: 'plan_mode_complete', version: 1, plan: 'plan' } } }),
    event(6, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'error', content: 'answer' } }),
    event(7, { type: 'unknown' }),
  ]), attachments: [attachment] }
  const first = timelineItems(undefined, [live], [])
  const cached = timelineItems(undefined, [live], [])
  const cold = timelineItems(undefined, [structuredClone(live)], [])
  expect(cached).toEqual(first)
  expect(cached).toEqual(cold)
  expect(cached[0]!.parts.filter((part) => part.kind === 'tool')).toHaveLength(1)
  expect(toolStatus(cached[0]!.parts.find((part) => part.kind === 'tool')!.events)).toBe('完成')
  expect(cached[0]).toMatchObject({ attachments: [attachment], plan: { text: 'plan' }, modelErrors: [{ message: 'error' }] })
})

it('rechecks attachment consistency against the current history without contaminating the cache', () => {
  const attachment = { id: 'a'.repeat(64), kind: 'image' as const, name: 'image', size: 100, mediaType: 'image/png' }
  const live = turn('prompt', [event(1, { type: 'message_start', message: { role: 'user', content: 'prompt' } })])
  const persisted = history('native', 'prompt', 'answer')
  persisted[0]!.raw.message = { role: 'user', content: [{ type: 'text', text: 'prompt' }, { type: 'image', attachment }] }
  const withHistory = timelineItems(persisted, [live], [])[0]!
  expect(withHistory.attachments).toEqual([])
  expect(withHistory.attachmentWarning).toContain('不一致')
  const withoutHistory = timelineItems(undefined, [live], [])[0]!
  expect(withoutHistory.attachments).toBeUndefined()
  expect(withoutHistory.attachmentWarning).toBeUndefined()
})
