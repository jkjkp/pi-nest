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

it('keeps partial completion visible while moving per-file descriptions to hover', async () => {
  const files = projectTurnFiles([tool('one', '../outside.md', 'write'), tool('two', '../outside.md', 'write', '失败')], '/project')
  await act(async () => root.render(<TurnFileSummary files={files} state="aborted" />))
  expect(container.textContent).toContain('任务已中断')
  expect(container.textContent).not.toContain('后续操作失败')
  expect(container.textContent).not.toContain('项目外')
  expect(container.querySelector('li')?.title).toContain('后续操作失败')
  expect(container.querySelector('li')?.title).toContain('项目外')
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

it('shows the filename followed by the full path in each changed-file row', async () => {
  const files = projectTurnFiles([tool('one', 'docs/TODOTask.md', 'write')], '/project')
  const openFile = vi.fn()
  await act(async () => root.render(<OpenToolFile value={openFile}><TurnFileSummary files={files} state="complete" /></OpenToolFile>))
  const row = container.querySelector('li')!
  const link = row.querySelector('button')!
  expect(link.textContent).toBe('TODOTask.md')
  expect(link.nextElementSibling?.textContent).toBe('/project/docs/TODOTask.md')
  await act(async () => link.click())
  expect(openFile).toHaveBeenCalledWith('/project/docs/TODOTask.md', undefined, undefined)
})

it('shows persisted net counts for repeated writes and edits instead of adding operation totals', async () => {
  const write = tool('one', 'a.ts', 'write')
  write.result!.fileChange = { version: 1, path: '/project/a.ts', sequence: 1, added: 20, removed: 10, changeType: 'modified' }
  const edit = tool('two', './a.ts')
  edit.result!.fileChange = { version: 1, path: '/project/a.ts', sequence: 2, added: 3, removed: 2, changeType: 'modified' }
  const files = projectTurnFiles([write, edit], '/project')
  expect(files).toHaveLength(1)
  expect(files[0]?.changes).toEqual({ added: 3, removed: 2 })
  await act(() => root.render(<TurnFileSummary files={files} state="complete" />))
  expect(container.textContent).toContain('+3')
  expect(container.textContent).toContain('−2')
  expect(container.textContent).not.toContain('+23')
  const reordered = projectTurnFiles([edit, write], '/project')
  expect(reordered[0]?.changes).toEqual({ added: 3, removed: 2 })
})

it('uses the final snapshot for deletion and reversion, and retains partial writes after failure', () => {
  const write = tool('one', 'a.ts', 'write', '失败')
  write.result!.fileChange = { version: 1, path: '/project/a.ts', sequence: 1, added: 1, removed: 1, changeType: 'modified' }
  expect(projectTurnFiles([write], '/project')[0]?.changes).toEqual({ added: 1, removed: 1 })
  const deleted = projectTurnFiles([write], '/project', [{ version: 1, path: '/project/a.ts', sequence: 2, added: 0, removed: 5, changeType: 'deleted' }])
  expect(deleted[0]).toMatchObject({ changes: { added: 0, removed: 5 }, status: '已删除 · 含失败操作' })
  const reverted = projectTurnFiles([tool('done', 'a.ts')], '/project', [{ version: 1, path: '/project/a.ts', sequence: 3, added: 0, removed: 0, changeType: 'unchanged' }])
  expect(reverted[0]?.changes).toEqual({ added: 0, removed: 0 })
  expect(reverted[0]?.status).toContain('无净变化')
})

it('explains unavailable statistics for each file without pretending they are zero', async () => {
  const files = projectTurnFiles([tool('old', 'old.ts', 'write')], '/project', [
    { version: 1, path: '/project/image.png', sequence: 1, reason: 'binary' },
    { version: 1, path: '/project/large.log', sequence: 2, reason: 'too_large' },
  ])
  await act(() => root.render(<TurnFileSummary files={files} state="complete" />))
  expect(container.querySelectorAll('li [aria-hidden="true"]')).toHaveLength(3)
  expect(container.querySelector('[title="行数未记录"]')?.textContent).toContain('—')
  expect(container.querySelector('[title="二进制文件"]')?.textContent).toContain('—')
  expect(container.querySelector('[title="文件过大，未统计"]')?.textContent).toContain('—')
  expect(container.textContent).not.toContain('+0')
})

it.each([
  { cwd: 'D:\\Project', relative: 'src\\a.ts', absolute: 'd:/project/src/a.ts' },
  { cwd: '\\\\server\\share\\Project', relative: 'src\\a.ts', absolute: '//server/share/Project/src/a.ts' },
])('matches Windows absolute statistics with the same relative tool path (%s)', ({ cwd, relative, absolute }) => {
  const files = projectTurnFiles([tool('one', relative, 'write')], cwd, [{ version: 1, path: absolute, sequence: 1, added: 2, removed: 0, changeType: 'created' }])
  expect(files).toHaveLength(1)
  expect(files[0]).toMatchObject({ changes: { added: 2, removed: 0 }, outsideProject: false })
})


it('keeps long file rows on one line, truncates names and paths, and reserves space for counts', async () => {
  const name = 'long-file-name-'.repeat(20) + '.ts'
  const path = `/project/${'nested/'.repeat(30)}${name}`
  const files = projectTurnFiles([tool('long', path)], '/project')
  const openFile = vi.fn()
  await act(() => root.render(<OpenToolFile value={openFile}><TurnFileSummary files={files} state="complete" /></OpenToolFile>))
  const row = container.querySelector('li')!
  const link = row.querySelector('button')!
  expect(row.classList.contains('flex')).toBe(true)
  expect(row.classList.contains('flex-wrap')).toBe(false)
  expect(link.classList.contains('truncate')).toBe(true)
  expect(link.title).toBe(path)
  expect(link.nextElementSibling?.classList.contains('truncate')).toBe(true)
  expect(link.nextElementSibling?.getAttribute('title')).toBe(path)
  expect(row.lastElementChild?.classList.contains('shrink-0')).toBe(true)
  expect(row.lastElementChild?.textContent).toBe('+1 −1')
  expect(row.textContent).not.toContain('已编辑')
  await act(() => link.click())
  expect(openFile).toHaveBeenCalledWith(path, undefined, undefined)
})
