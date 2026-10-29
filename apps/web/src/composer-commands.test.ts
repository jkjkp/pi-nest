import { expect, it } from 'vitest'
import { commandToken, completeCommand, matchingCommands, parseComposerCommand, lastCompletedAssistantText } from './composer-commands.js'

it('suggests only a slash at the beginning or after whitespace, at the end of the active token', () => {
  for (const value of ['/', '/pl', ' /pl', '你好 /pl', '你好\t/pl', '正文\n/pl']) {
    expect(commandToken(value, value.length)).toEqual({ start: value.lastIndexOf('/'), end: value.length, query: value.slice(value.lastIndexOf('/') + 1) })
  }
  for (const value of ['*****/pl', '你好/pl', '/plan ', '路径/foo/pl', '/pl/an', '普通文本']) expect(commandToken(value, value.length)).toBeUndefined()
  expect(commandToken('/plan', 3)).toBeUndefined()
  expect(commandToken('/pl', 0, 3)).toBeUndefined()
  expect(commandToken('你好 /pl 后续', 6)).toEqual({ start: 3, end: 6, query: 'pl' })
})

it('replaces only the active command and preserves surrounding text', () => {
  const value = '你好 /pl 后续'
  expect(completeCommand(value, commandToken(value, 6)!, 'plan')).toEqual({ value: '你好 /plan 后续', caret: 9 })
  expect(completeCommand(' /pl', commandToken(' /pl', 4)!, 'plan')).toEqual({ value: ' /plan ', caret: 7 })
})

it('matches prefixes without case sensitivity and deduplicates the GUI command', () => {
  const commands = [
    { name: 'plan', description: 'Plan', source: 'extension' as const },
    { name: 'planning', source: 'prompt' as const },
    { name: 'compact', description: 'Override', source: 'extension' as const },
    { name: 'skill:test', source: 'skill' as const },
  ]
  expect(matchingCommands(commands, 'PL').map((command) => command.name)).toEqual(['plan', 'planning'])
  expect(matchingCommands(commands, 'skill:')[0]?.name).toBe('skill:test')
  expect(matchingCommands(commands, 'unknown')).toEqual([])
  expect(matchingCommands(commands, '').filter((command) => command.name === 'compact')).toHaveLength(1)
  expect(matchingCommands(commands, 'fork').map((command) => command.name)).toEqual(['fork'])
})

it.each([
  { name: 'plan', prefixes: ['/', '/p', '/pl', '/pla', '/plan'] },
  { name: 'fork', prefixes: ['/', '/f', '/fo', '/for', '/fork'] },
  { name: 'ponytail', prefixes: ['/', '/p', '/po', '/pony', '/ponytail'] },
])('matches each typed prefix of any registered command: $name', ({ name, prefixes }) => {
  for (const prefix of prefixes) {
    for (const before of ['', ' ', '你好 ']) {
      const value = before + prefix
      const token = commandToken(value, value.length)!
      expect(matchingCommands([{ name, source: 'extension' }], token.query).some((command) => command.name === name)).toBe(true)
    }
  }
})

it('parses exact commands and preserves parameters without interpreting commands inside prose', () => {
  expect(parseComposerCommand('  /COMPACT -- instructions  ')).toEqual({ name: 'compact', argument: 'instructions' })
  expect(parseComposerCommand('/compact -- 保留接口\n保留约束')).toEqual({ name: 'compact', argument: '保留接口\n保留约束' })
  expect(parseComposerCommand(' /RENAME ')).toEqual({ name: 'rename', argument: '' })
  expect(parseComposerCommand('/name')).toBeUndefined()
  expect(matchingCommands([], 'name')).toEqual([])
  for (const value of ['/model', '/model fixture/model', '/thinking', '/thinking high', '/modelx', '/p', '你好 /model', '*****/model', '/model/path']) expect(parseComposerCommand(value)).toBeUndefined()
  expect(matchingCommands([], '').map((command) => command.name)).toEqual(['compact', 'rename', 'session', 'copy', 'fork', 'clone', 'settings'])
})

it.each(['/compact 是干啥用的？', '/compact 保留接口设计', '/compact\n这是什么命令', '/compactabc', '/compact?', '/compact --help', '/compact --保留接口'])('leaves %s as ordinary prompt text', (text) => {
  expect(parseComposerCommand(text)).toBeUndefined()
})

it.each(['/compact', '/compact ', '  /COMPACT\n'])('recognizes the standalone command %s', (text) => {
  expect(parseComposerCommand(text)).toEqual({ name: 'compact', argument: '' })
})

it.each(['/compact --', '/compact -- \n'])('recognizes %s as an incomplete explicit command instead of compacting', (text) => {
  expect(parseComposerCommand(text)).toMatchObject({ name: 'compact', argument: '', error: expect.stringContaining('/compact --') })
})

it('copies only the latest completed assistant text across history and runtime without thinking or unfinished output', () => {
  const entries = [{ id: 'a', parentId: null, type: 'message', timestamp: '2026-10-16T00:00:00Z', raw: { message: { role: 'assistant', content: 'Old' } } }]
  const completed = { id: 'b', startedAt: '2026-10-16T00:01:00Z', completedAt: '2026-10-16T00:02:00Z', events: [{ sessionId: 'one', sequence: 1, observedAt: '2026-10-16T00:02:00Z', event: { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '**New**' }, { type: 'text', text: 'second' }] } } }] }
  expect(lastCompletedAssistantText(entries, [completed])).toBe('**New**\nsecond')
  expect(lastCompletedAssistantText(entries, [{ ...completed, completedAt: undefined }])).toBe('Old')
  expect(lastCompletedAssistantText(entries, [{ ...completed, events: [{ ...completed.events[0]!, event: { type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', content: 'partial' } } }] }])).toBe('Old')
  expect(lastCompletedAssistantText([], [])).toBeUndefined()
})
