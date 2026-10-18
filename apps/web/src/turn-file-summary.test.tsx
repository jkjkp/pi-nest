// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TurnFileSummary } from './turn-file-summary.js'
import { projectTurnFiles, projectTurnPresentation, turnFileSummaryState, type TurnActivity } from './turn-execution-model.js'
import { OpenToolFile } from './tool-file-context.js'
import type { TimelineItem } from './timeline-model.js'
import type { ToolResult } from './tool-result-model.js'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div')
document.body.append(container)
let root = createRoot(container)
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(container) })

function tool(id: string, path: string, view: 'edit' | 'write' = 'edit', status = '完成'): Extract<TurnActivity, { kind: 'tool' }> {
  const result: ToolResult = { name: view, view, path, status, args: { path, content: 'recorded file' }, output: 'operation failed', patch: view === 'edit' && status === '完成' ? '@@ -1 +1 @@\n-old\n+new\n' : undefined, changes: view === 'edit' && status === '完成' ? { added: 1, removed: 1 } : undefined, details: {}, notices: [] }
  return { kind: 'tool', id, result, status, label: path, duration: undefined, events: [{ id, event: { toolCallId: id }, raw: {}, observedAt: '2026-10-18T00:00:00Z' }] }
}
const item: TimelineItem = { kind: 'turn', id: 'one', events: [], parts: [], diagnostics: [], startedAt: '2026-10-18T00:00:00Z', prompt: 'go' }

it('deduplicates normalized paths, repeated call records and structured reports without adding patch totals', () => {
  const one = tool('one', './src/../a.ts')
  const files = projectTurnFiles([one, { ...one, id: 'duplicate' }, { kind: 'file_change', id: 'reported', label: 'changed', changes: [{ path: '/project/a.ts', added: 300, removed: 300 }] }, tool('two', 'a.ts')], '/project')
  expect(files).toHaveLength(1)
  expect(files[0]).toMatchObject({ path: '/project/a.ts', displayPath: 'a.ts', status: '多次编辑', operations: [one, expect.objectContaining({ id: 'two' })] })
  expect(files[0]?.changes).toBeUndefined()
  expect(projectTurnFiles([one], '/project')[0]?.changes).toEqual({ added: 1, removed: 1 })
})

it('keeps successful writes followed by failures, excludes failure-only and read-only calls', () => {
  const read = { ...tool('read', 'read.ts'), result: { ...tool('read', 'read.ts').result!, view: 'read' as const } }
  const files = projectTurnFiles([tool('one', '../outside.md', 'write'), tool('two', '../outside.md', 'write', '失败'), tool('bad', 'bad.ts', 'edit', '失败'), read], '/project')
  expect(files).toHaveLength(1)
  expect(files[0]).toMatchObject({ path: '/outside.md', outsideProject: true, status: '已写入 · 后续操作失败' })
  expect(files[0]?.changes).toBeUndefined()
  expect(projectTurnFiles([{ kind: 'bash', id: 'bash', command: 'touch hidden.txt', status: '完成', events: [], stdout: 'hidden.txt', stderr: undefined, exitCode: 0, cwd: '/project', duration: undefined }], '/project')).toEqual([])
})

it('does not group different directories by basename and resolves operation-time cwd', () => {
  const first = tool('one', 'a.ts')
  first.result!.args.cwd = '/project/src'
  const files = projectTurnFiles([first, tool('two', 'a.ts'), tool('three', '/project-other/a.ts')], '/project')
  expect(files.map((file) => file.path)).toEqual(['/project/src/a.ts', '/project/a.ts', '/project-other/a.ts'])
  expect(files[2]?.outsideProject).toBe(true)
})

it('waits for an actual run or persisted response boundary, including interrupted runs', () => {
  const toolEnded = { ...item, events: [{ id: 'tool', event: { type: 'tool_execution_end' }, raw: {}, observedAt: item.startedAt }] }
  expect(turnFileSummaryState(toolEnded, false)).toBeUndefined()
  for (const status of ['submitted', 'awaiting_agent', 'awaiting_input', 'running', 'aborting'] as const) expect(turnFileSummaryState(item, false, status)).toBeUndefined()
  expect(turnFileSummaryState(item, true, 'complete')).toBeUndefined()
  expect(turnFileSummaryState(item, false, 'complete')).toBe('complete')
  expect(turnFileSummaryState(item, false, 'aborted')).toBe('aborted')
  expect(turnFileSummaryState(item, false, 'error')).toBe('error')
  expect(turnFileSummaryState({ ...item, runtimeTiming: { startedAt: item.startedAt, completedAt: item.startedAt } }, false)).toBe('complete')
  expect(turnFileSummaryState({ ...item, events: [{ id: 'assistant', event: { message: { role: 'assistant', stopReason: 'toolUse' } }, raw: {}, observedAt: item.startedAt }] }, false)).toBeUndefined()
  expect(turnFileSummaryState({ ...item, events: [{ id: 'assistant', event: { message: { role: 'assistant', stopReason: 'stop' } }, raw: {}, observedAt: item.startedAt }] }, false)).toBe('complete')
  expect(turnFileSummaryState(item, false, undefined, true)).toBe('complete')
})

it('shows only a compact first-three file list with working current-file preview links', async () => {
  const files = projectTurnFiles([tool('one', 'a.ts'), tool('two', 'b.ts'), tool('three', 'c.ts'), tool('four', 'd.ts', 'write')], '/project')
  const openFile = vi.fn()
  await act(async () => root.render(<OpenToolFile value={openFile}><TurnFileSummary files={files} state="complete" /></OpenToolFile>))
  expect(container.textContent).toContain('文件变更 · 4 个文件')
  expect(container.textContent).not.toContain('d.ts')
  expect(container.textContent).not.toContain('-old')
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('再显示'))!.click())
  expect(container.textContent).toContain('d.ts')
  expect(container.textContent).not.toContain('查看变更')
  expect(container.textContent).not.toContain('收起变更')
  expect(container.textContent).not.toContain('recorded file')
  expect(container.querySelectorAll('button[title]')).toHaveLength(4)
  await act(async () => container.querySelector<HTMLButtonElement>('button[title]')!.click())
  expect(openFile).toHaveBeenCalledWith('/project/a.ts', undefined, undefined)
  expect([...container.querySelectorAll('button')].some((button) => /复制|撤销/.test(button.textContent ?? ''))).toBe(false)
})

it('flags partial completion and project-external files without expanding historical details', async () => {
  const files = projectTurnFiles([tool('one', '../outside.md', 'write'), tool('two', '../outside.md', 'write', '失败')], '/project')
  await act(async () => root.render(<TurnFileSummary files={files} state="aborted" />))
  expect(container.textContent).toContain('任务已中断')
  expect(container.textContent).toContain('后续操作失败')
  expect(container.textContent).toContain('项目外')
  expect(container.textContent).not.toContain('recorded file')
  expect(container.textContent).not.toContain('operation failed')
  expect(container.textContent).not.toContain('查看变更')
})

it('recognizes persisted abort flags and waits beyond an intermediate agent end', () => {
  expect(turnFileSummaryState({ ...item, events: [{ id: 'settled', event: { type: 'agent_settled', aborted: true }, raw: {}, observedAt: item.startedAt }] }, false)).toBe('aborted')
  expect(turnFileSummaryState({ ...item, events: [{ id: 'ended', event: { type: 'agent_end' }, raw: {}, observedAt: item.startedAt }] }, false)).toBeUndefined()
})

it('ignores failed structured file-change reports and keeps only successful reported paths', () => {
  const events = [
    { id: 'bad', raw: {}, observedAt: item.startedAt, event: { type: 'file_changes', isError: true, changes: [{ path: 'bad.ts' }] } },
    { id: 'mixed', raw: {}, observedAt: item.startedAt, event: { type: 'file_changes', changes: [{ path: 'also-bad.ts', isError: true }, { path: 'good.ts' }] } },
  ]
  const presentation = projectTurnPresentation({ ...item, parts: [{ kind: 'file_change', events }] }, false)
  expect(projectTurnFiles(presentation.activities, '/project').map((file) => file.path)).toEqual(['/project/good.ts'])
})
