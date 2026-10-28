import { expect, it } from 'vitest'
import { isPiMessage, piAssistantStopReason, piToolCallId } from './pi-events.js'
import nativeEvents from '../test-fixtures/native-pi-events.json'

// Captured from Pi CLI 1.2.0 with an isolated local response server and the real read tool.
it('reads recorded native user, assistant and tool events without changing their payloads', () => {
  const original = JSON.stringify(nativeEvents)
  const user = nativeEvents.find((event) => event.type === 'message_start')!
  expect(isPiMessage(user.message, 'user')).toBe(true)
  expect(nativeEvents.filter((event) => event.type === 'message_end').map(piAssistantStopReason)).toEqual(['toolUse', 'stop'])
  const tools = nativeEvents.filter((event) => ['tool_execution_start', 'tool_execution_end'].includes(event.type))
  expect(tools.map((event) => piToolCallId(event, event.message))).toEqual(['read-fixture', 'read-fixture'])
  const result = nativeEvents.find((event) => event.message?.role === 'toolResult')!
  expect(piToolCallId(result, result.message)).toBe('read-fixture')
  expect(piAssistantStopReason(nativeEvents.at(-1)!)).toBeUndefined()
  expect(JSON.stringify(nativeEvents)).toBe(original)
})

it.each([null, undefined, false, 0, '', [], { role: 'assistant' }, { role: 'future' }])('keeps non-user message shapes unrecognized: %j', (message) => {
  expect(isPiMessage(message, 'user')).toBe(false)
})

it('recognizes message roles without validating content or rejecting future fields', () => {
  expect(isPiMessage({ role: 'user', content: 42, future: true }, 'user')).toBe(true)
  expect(isPiMessage(Object.create({ role: 'user' }), 'user')).toBe(true)
  expect(isPiMessage(Object.assign([], { role: 'user' }), 'user')).toBe(false)
})

it.each(['stop', 'error', 'aborted', 'length', '', 'future-reason'])('preserves the exact assistant stop reason: %j', (reason) => {
  const event = Object.freeze({ type: 'message_end', message: Object.freeze({ role: 'assistant', stopReason: reason, future: true }) })
  expect(piAssistantStopReason(event)).toBe(reason)
  expect(piAssistantStopReason({ ...event, type: 'message_start' })).toBeUndefined()
  expect(piAssistantStopReason({ ...event, type: 'future_event' })).toBeUndefined()
})

it.each([null, [], { role: 'user', stopReason: 'stop' }, { role: 'assistant', stopReason: 0 }, { role: 'assistant' }])('ignores an unreadable stop reason without rejecting the payload: %j', (message) => {
  expect(piAssistantStopReason({ type: 'message_end', message })).toBeUndefined()
})

it.each([
  ['root', 'nested', 'root'],
  [null, 'nested', 'nested'],
  [undefined, 'nested', 'nested'],
  ['', 'nested', ''],
  [0, 'nested', undefined],
  [false, 'nested', undefined],
  [undefined, 0, undefined],
])('keeps nullish tool ID precedence: root=%j, nested=%j', (root, nested, expected) => {
  expect(piToolCallId({ toolCallId: root }, { toolCallId: nested })).toBe(expected)
})

it('preserves the caller-specific handling of unusual nested tool messages', () => {
  const message = Object.assign([], { toolCallId: 'array-id' })
  expect(piToolCallId({}, message)).toBe('array-id')
  expect(piToolCallId({}, undefined)).toBeUndefined()
})
