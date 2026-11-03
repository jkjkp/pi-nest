// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionGraphWorkspace } from './session-graph-workspace.js'
import type { GraphSelection } from './session-graph-preview.js'
import { useWorkspaceStore } from './workspace-store.js'
import { fetchSessionGraph, fetchSessionHistory, fetchSessionTurnIndex } from './workspace-api.js'
const onSelect = vi.fn(); const onBranch = vi.fn()
const sessions = [{ id: 'source', name: 'Root', cwd: '/w' }, { id: 'other', name: 'Other', cwd: '/w', parentSessionId: 'source' }, { id: 'grandchild', name: 'Grandchild', cwd: '/w', parentSessionId: 'other' }]
vi.mock('./workspace-api.js', () => ({
  fetchSessionGraph: vi.fn(), fetchSessionHistory: vi.fn(), fetchSessionTurnIndex: vi.fn(),
}))
vi.mock('./session-timeline.js', () => ({ SessionTimeline: (props: {
  onEditLast?: unknown; onRetrySteering?: unknown; sessionId: string; branchDisabled?: boolean; history?: { entries: unknown[] }
  onBranchAnswer?: (id: string, revision: string) => Promise<void>; onBranchUser?: (id: string, revision: string) => Promise<void>
}) => <div data-preview-session={props.sessionId} data-mutable={Boolean(props.onEditLast || props.onRetrySteering)} data-entries={props.history?.entries.length}>
  Read only<button disabled={props.branchDisabled} onClick={() => void props.onBranchAnswer?.('a', 'r').catch(() => {})}>从此轮后新建分支</button>
  <button disabled={props.branchDisabled} onClick={() => void props.onBranchUser?.('u', 'r').catch(() => {})}>修改此轮新建分支</button>
</div> }))
let root: Root; let container: HTMLDivElement; let client: QueryClient
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); onSelect.mockReset(); onBranch.mockReset()
  vi.mocked(fetchSessionGraph).mockReset().mockResolvedValue({ sessions, branchStorage: { available: true } })
  vi.mocked(fetchSessionHistory).mockReset().mockImplementation(async (id, before) => ({ session: { id }, revision: 'r', entries: [{ id: before ? 'old' : 'u', parentId: null, type: 'message', timestamp: '', raw: { message: { role: 'user', content: 'question' } } }], hasEarlier: !before, beforeCursor: before ? undefined : 'older' }))
  vi.mocked(fetchSessionTurnIndex).mockReset().mockResolvedValue({ revision: 'r', entries: [] })
  useWorkspaceStore.setState({ runs: {}, sessionNotifications: {}, branchOperations: {} })
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals() })
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === name)!
const node = (id: string) => container.querySelector<HTMLButtonElement>(`[data-session-node="${id}"] > button`)!
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
function Fixture({ initial = 'source' }: { initial?: string }) {
  const [selection, setSelection] = useState<GraphSelection>()
  const [target, setTarget] = useState(initial)
  const [drafts, setDrafts] = useState<Record<string, string>>({ source: 'keep draft', other: 'other draft' })
  return <SessionGraphWorkspace enabled sessionId={target} selection={selection} onPreview={setSelection} onSelect={(id) => { onSelect(id); setTarget(id) }} onBranch={onBranch}>
    <textarea aria-label="Existing draft" value={drafts[target] ?? ''} onChange={(event) => setDrafts({ ...drafts, [target]: event.target.value })} />
  </SessionGraphWorkspace>
}
async function mount(initial?: string) {
  await act(async () => root.render(<QueryClientProvider client={client}><Fixture initial={initial} /></QueryClientProvider>)); await settle()
}
it('draws metadata only and previews only the requested session without changing target, draft or notifications', async () => {
  await mount()
  expect(container.querySelectorAll('[data-session-node]')).toHaveLength(3)
  expect(fetchSessionHistory).not.toHaveBeenCalled(); expect(fetchSessionTurnIndex).not.toHaveBeenCalled()
  const notifications = useWorkspaceStore.getState().sessionNotifications
  await act(async () => node('other').click()); await settle(); await settle()
  expect(onSelect).not.toHaveBeenCalled(); expect(onBranch).not.toHaveBeenCalled()
  expect(fetchSessionHistory).toHaveBeenCalledTimes(1)
  expect(vi.mocked(fetchSessionHistory).mock.calls[0][0]).toBe('other')
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('keep draft')
  expect(container.querySelector('[data-preview-session]')?.getAttribute('data-mutable')).toBe('false')
  expect(container.querySelector('textarea')?.parentElement?.inert).toBe(true)
  expect(container.textContent).toContain('正在预览 · Other'); expect(container.textContent).toContain('发送目标 · Root')
  expect(useWorkspaceStore.getState().sessionNotifications).toBe(notifications)
  await act(async () => button('切换到此会话继续').click()); await settle()
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('other')
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('other draft')
})
it('returns to the mounted current conversation and can page through the full preview path', async () => {
  await mount(); const input = container.querySelector('textarea')
  await act(async () => node('other').click()); await settle()
  await act(async () => button('加载更早对话').click()); await settle()
  expect(vi.mocked(fetchSessionHistory).mock.calls.at(-1)?.slice(0, 3)).toEqual(['other', 'older', 'r'])
  await act(async () => button('返回当前会话').click())
  expect(container.querySelector('textarea')).toBe(input)
  expect(input?.parentElement?.inert).toBe(false)
})
it.each(['edit', 'continue'] as const)('creates %s from the specific message and preview revision', async (mode) => {
  onBranch.mockResolvedValue(undefined); await mount()
  await act(async () => node('other').click()); await settle()
  await act(async () => button(mode === 'edit' ? '修改此轮新建分支' : '从此轮后新建分支').click())
  expect(onBranch).toHaveBeenCalledExactlyOnceWith('other', { kind: 'fork', mode, entryId: mode === 'edit' ? 'u' : 'a', revision: 'r' })
  expect(container.querySelector('textarea')?.parentElement?.inert).toBe(false)
})
it('does not clear a newer preview when an earlier branch operation finishes', async () => {
  let finish!: () => void
  onBranch.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  await mount(); await act(async () => node('other').click()); await settle()
  await act(async () => button('从此轮后新建分支').click())
  await act(async () => node('source').click()); await settle()
  await act(async () => finish()); await settle()
  expect(container.querySelector('[data-preview-session]')?.getAttribute('data-preview-session')).toBe('source')
})
it('folds descendants and locating the current session expands its path', async () => {
  await mount('grandchild')
  expect(node('grandchild')).toBeTruthy()
  await act(async () => button('适应画布').click())
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="折叠 Root 的子会话"]')!.click())
  expect(container.querySelectorAll('[data-session-node]')).toHaveLength(1)
  await act(async () => button('定位当前').click()); await settle()
  expect(node('grandchild')).toBeTruthy()
  await act(async () => button('适应画布').click())
  expect(container.querySelectorAll('[data-session-node]')).toHaveLength(3)
  expect(fetchSessionHistory).not.toHaveBeenCalled()
})
it('keeps native relations and the original conversation usable when SQLite is unavailable', async () => {
  vi.mocked(fetchSessionGraph).mockResolvedValue({ sessions, branchStorage: { available: false } })
  await mount(); expect(container.querySelectorAll('[data-session-node]')).toHaveLength(3)
  await act(async () => node('other').click()); await settle()
  expect(button('修改此轮新建分支').disabled).toBe(true)
  expect(button('从此轮后新建分支').disabled).toBe(true)
  await act(async () => button('返回当前会话').click())
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('keep draft')
})
it('adds a single child on refreshed skeleton metadata without reading its history', async () => {
  await mount()
  vi.mocked(fetchSessionGraph).mockResolvedValue({ sessions: [...sessions, { id: 'clone', cwd: '/w', parentSessionId: 'other' }], branchStorage: { available: true } })
  await act(async () => client.invalidateQueries({ queryKey: ['session-graph'] })); await settle()
  expect(container.querySelectorAll('[data-session-node]')).toHaveLength(4)
  expect(fetchSessionHistory).not.toHaveBeenCalled()
})

it('shows an existing background run notification without watching or loading that session', async () => {
  useWorkspaceStore.setState({ sessionNotifications: { other: { pendingRunId: 'background' } } })
  await mount()
  expect(node('other').textContent).toContain('推理中')
  expect(fetchSessionHistory).not.toHaveBeenCalled()
  expect(onSelect).not.toHaveBeenCalled()
})

it('keeps a lost acknowledgement visible on the preview source and forbids a second creation', async () => {
  onBranch.mockImplementation(async (id, request) => {
    useWorkspaceStore.getState().setBranchOperation(id, { operationId: 'uncertain', request })
    throw new Error('分支结果待确认，请查询结果。')
  })
  await mount(); await act(async () => node('other').click()); await settle()
  await act(async () => button('从此轮后新建分支').click())
  expect(container.textContent).toContain('分支结果待确认，请查询结果。')
  expect(container.textContent).toContain('切换到此会话后查询结果')
  expect(button('从此轮后新建分支').disabled).toBe(true)
  expect(useWorkspaceStore.getState().branchOperations.other?.operationId).toBe('uncertain')
})
