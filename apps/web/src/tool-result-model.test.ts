import { describe, expect, it } from 'vitest'
import { timelineItems, type TimelinePart } from './timeline-model.js'
import { patchChanges, projectToolResult, searchMatches } from './tool-result-model.js'

function part(events: Record<string, unknown>[], name = 'edit', args: Record<string, unknown> = { path: 'a.ts' }): Extract<TimelinePart, { kind: 'tool' }> {
  return { kind: 'tool', toolName: name, toolCallId: 'one', arguments: args, events: events.map((event, index) => ({ event, raw: event, id: String(index), observedAt: '2026-10-18T00:00:00Z' })) }
}
const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n'

describe('tool result projection', () => {
  it('uses final results instead of concatenating cumulative stream snapshots', () => {
    const result = projectToolResult(part([
      { partialResult: { content: [{ type: 'text', text: 'a' }] }, type: 'tool_execution_update' },
      { partialResult: { content: [{ type: 'text', text: 'ab' }] }, type: 'tool_execution_update' },
      { result: { content: [{ type: 'text', text: 'abc' }] }, type: 'tool_execution_end' },
    ], 'bash'))
    expect(result.output).toBe('abc')
    expect(result.status).toBe('完成')
    expect(projectToolResult(part([{ partialResult: { content: [{ type: 'text', text: 'ab' }] }, type: 'tool_execution_update' }], 'bash')).output).toBe('ab')
  })

  it('shows only successful actual edits, and never invents write diffs', () => {
    const success = projectToolResult(part([{ type: 'tool_execution_end', result: { details: { patch, diff: 'display diff', firstChangedLine: 2 } } }]))
    expect(success.changes).toEqual({ added: 2, removed: 1 })
    expect(success.patch).toBe(patch)
    const failure = projectToolResult(part([{ type: 'tool_execution_end', isError: true, result: { content: [{ type: 'text', text: 'not found' }], details: { patch } } }]))
    expect(failure.status).toBe('失败')
    expect(failure.patch).toBeUndefined()
    expect(failure.output).toBe('not found')
    expect(projectToolResult(part([{ type: 'tool_execution_end', result: { details: { patch } } }], 'write')).patch).toBeUndefined()
  })

  it('retains truncation, non-text content and search limits', () => {
    const result = projectToolResult(part([{ type: 'message', message: { role: 'toolResult', content: [{ type: 'image', data: 'hidden' }], details: { truncation: { truncated: true }, linesTruncated: true, matchLimitReached: 10 } } }], 'grep'))
    expect(result.notices).toHaveLength(4)
    expect(result.output).not.toContain('hidden')
    expect(searchMatches(result)).toBeUndefined()
  })

  it('pairs interleaved calls by ID despite missing names and keeps unidentified calls separate', () => {
    const events = [
      { type: 'tool_execution_start', toolCallId: 'one', toolName: 'read', args: { path: 'one.ts' } },
      { type: 'tool_execution_start', toolCallId: 'two', toolName: 'read', args: { path: 'two.ts' } },
      { type: 'tool_execution_end', toolCallId: 'one', result: { content: [{ type: 'text', text: 'one' }] } },
      { type: 'message_end', message: { role: 'toolResult', toolCallId: 'one', content: [{ type: 'text', text: 'one' }] } },
      { type: 'tool_execution_end', toolCallId: 'two', result: { content: [{ type: 'text', text: 'two' }] } },
      { type: 'tool_execution_start', toolName: 'custom' },
      { type: 'tool_execution_start', toolName: 'custom' },
    ].map((event, sequence) => ({ event, sequence, sessionId: 's', observedAt: '2026-10-18T00:00:00Z' }))
    const [turn] = timelineItems(undefined, [{ id: 'turn', prompt: 'go', startedAt: '2026-10-18T00:00:00Z', events }], [])
    const tools = turn!.parts.filter((value) => value.kind === 'tool')
    expect(tools).toHaveLength(4)
    expect(tools.slice(0, 2).map((part) => projectToolResult(part)).map((value) => [value.path, value.output])).toEqual([['one.ts', 'one'], ['two.ts', 'two']])
    const historical = projectToolResult(part([{ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'one' }] } }], 'read', { path: 'one.ts' }))
    expect(projectToolResult(tools[0]!)).toMatchObject(historical)
  })
})

it('validates complete multi-hunk patches before counting changes', () => {
  expect(patchChanges(patch + '@@ -8 +9 @@\n-a\n+b\n')).toEqual({ added: 3, removed: 2 })
  expect(patchChanges(patch.replace('+extra\n', ''))).toBeUndefined()
  expect(patchChanges('not a patch')).toBeUndefined()
  expect(patchChanges('@@ -0,0 +1 @@\n+new\n')).toEqual({ added: 1, removed: 0 })
  expect(patchChanges(patch + '--- a/other\n+++ b/other\n')).toBeUndefined()
})

it('only structures unambiguous native grep output without context or truncation', () => {
  const result = projectToolResult(part([{ type: 'tool_execution_end', result: { content: 'src/a.ts:4: hello\nsrc/a.ts:9: world' } }], 'grep', { pattern: 'hello' }))
  expect(searchMatches(result)).toEqual([{ path: 'src/a.ts', line: 4, text: 'hello' }, { path: 'src/a.ts', line: 9, text: 'world' }])
  expect(searchMatches({ ...result, output: 'file:4: value:12: ambiguous' })).toBeUndefined()
  expect(searchMatches({ ...result, args: { context: 2 } })).toBeUndefined()
  expect(searchMatches({ ...result, view: 'generic' })).toBeUndefined()
})

it('does not leave a settled call without a result looking active', () => {
  expect(projectToolResult(part([{ type: 'tool_execution_start' }]), true).status).toBe('结果未记录')
})
