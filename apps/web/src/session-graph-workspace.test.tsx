// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionGraphWorkspace } from './session-graph-workspace.js'
import type { GraphSelection } from './session-graph-preview.js'
import { useWorkspaceStore } from './workspace-store.js'
import { fetchSessionGraph, fetchSessionHistory, fetchSessionTurnIndex } from './workspace-api.js'
const onRename = vi.fn(); const onClone = vi.fn(); const onDelete = vi.fn()
const onSelect = vi.fn(); const onBranch = vi.fn(); const onCurrentNodeClick = vi.fn()
const onRead = vi.fn((sessionId: string, runId: string) => useWorkspaceStore.getState().markSessionRead(sessionId, runId))
const sessions = [{ id: 'source', name: 'Root', cwd: '/w' }, { id: 'other', name: 'Other', cwd: '/w', parentSessionId: 'source' }, { id: 'grandchild', name: 'Grandchild', cwd: '/w', parentSessionId: 'other' }]
vi.mock('./workspace-api.js', () => ({
  fetchSessionGraph: vi.fn(), fetchSessionHistory: vi.fn(), fetchSessionTurnIndex: vi.fn(),
}))
vi.mock('./session-timeline.js', () => ({ SessionTimeline: (props: {
  onEditLast?: unknown; onRetrySteering?: unknown; sessionId: string; branchDisabled?: boolean; history?: { entries: unknown[] }
  onBranchAnswer?: (id: string, revision: string) => Promise<void>
}) => <div data-preview-session={props.sessionId} data-mutable={Boolean(props.onEditLast || props.onRetrySteering)} data-entries={props.history?.entries.length}>
  Read only<button disabled={props.branchDisabled} onClick={() => void props.onBranchAnswer?.('a', 'r').catch(() => {})}>从此轮后新建分支</button>
</div> }))
let root: Root; let container: HTMLDivElement; let client: QueryClient
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); onSelect.mockReset(); onBranch.mockReset(); onCurrentNodeClick.mockReset(); onRead.mockClear()
  for (const action of [onRename, onClone, onDelete]) action.mockReset().mockResolvedValue(undefined)
  vi.mocked(fetchSessionGraph).mockReset().mockResolvedValue({ sessions, branchStorage: { available: true } })
  vi.mocked(fetchSessionHistory).mockReset().mockImplementation(async (id, before) => ({ session: { id }, revision: 'r', entries: [{ id: before ? 'old' : 'u', parentId: null, type: 'message', timestamp: '', raw: { message: { role: 'user', content: 'question' } } }], hasEarlier: !before, beforeCursor: before ? undefined : 'older' }))
  vi.mocked(fetchSessionTurnIndex).mockReset().mockResolvedValue({ revision: 'r', entries: [] })
  useWorkspaceStore.setState({ runs: {}, sessionNotifications: {}, branchOperations: {}, graphSplitRatio: 0.45 })
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals() })
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === name)!
const node = (id: string) => container.querySelector<HTMLButtonElement>(`[data-session-node="${id}"] > button`)!
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
function Fixture({ initial = 'source' }: { initial?: string }) {
  const [selection, setSelection] = useState<GraphSelection>()
  const [target, setTarget] = useState(initial)
  const [drafts, setDrafts] = useState<Record<string, string>>({ source: 'keep draft', other: 'other draft' })
  return <SessionGraphWorkspace enabled currentReadReady={false} sessionId={target} selection={selection} onPreview={setSelection} onCurrentNodeClick={() => { onCurrentNodeClick(); setSelection(undefined) }} onSelect={(id) => { onSelect(id); setTarget(id) }} onBranch={onBranch} onRename={onRename} onClone={onClone} onDelete={onDelete} onRead={onRead}>
    <textarea aria-label="Existing draft" value={drafts[target] ?? ''} onChange={(event) => setDrafts({ ...drafts, [target]: event.target.value })} />
  </SessionGraphWorkspace>
}
async function mount(initial?: string) {
  await act(async () => root.render(<QueryClientProvider client={client}><Fixture initial={initial} /></QueryClientProvider>)); await settle()
}
it('clamps the visible split to panel minimums and restores the saved preference after narrow mode without remounting the draft', async () => {
  let width = 1000
  const observers = new Set<() => void>()
  vi.stubGlobal('ResizeObserver', class {
    readonly resize: () => void
    constructor(callback: (entries: { contentRect: { width: number; height: number } }[]) => void) { this.resize = () => callback([{ contentRect: { width, height: 700 } }]) }
    observe() { observers.add(this.resize); this.resize() }
    disconnect() { observers.delete(this.resize) }
  })
  useWorkspaceStore.getState().setGraphSplitRatio(0.7)
  await mount()
  const draft = container.querySelector('textarea')
  expect(container.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')).toBe('64')
  expect(useWorkspaceStore.getState().graphSplitRatio).toBe(0.7)
  await act(async () => { width = 800; observers.forEach((resize) => resize()) })
  expect(container.querySelector('[role="separator"]')).toBeNull()
  expect(button('查看对话')).toBeTruthy()
  await act(async () => { width = 1600; observers.forEach((resize) => resize()) })
  expect(container.querySelector('[role="separator"]')?.getAttribute('aria-valuenow')).toBe('70')
  expect(container.querySelector('textarea')).toBe(draft)
  expect(draft?.value).toBe('keep draft')
  expect(fetchSessionGraph).toHaveBeenCalledTimes(1)
  expect(fetchSessionHistory).not.toHaveBeenCalled()
})
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
it('creates a continuation branch from the specific answer and preview revision', async () => {
  onBranch.mockResolvedValue(undefined); await mount()
  await act(async () => node('other').click()); await settle()
  await act(async () => button('从此轮后新建分支').click())
  expect(onBranch).toHaveBeenCalledExactlyOnceWith('other', { kind: 'fork', mode: 'continue', entryId: 'a', revision: 'r' })
  expect(container.querySelector('textarea')?.parentElement?.inert).toBe(false)
})
it('does not clear a newer preview when an earlier branch operation finishes', async () => {
  let finish!: () => void
  onBranch.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  await mount(); await act(async () => node('other').click()); await settle()
  await act(async () => button('从此轮后新建分支').click())
  await act(async () => node('grandchild').click()); await settle()
  await act(async () => finish()); await settle()
  expect(container.querySelector('[data-preview-session]')?.getAttribute('data-preview-session')).toBe('grandchild')
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

it.each([false, true])('keeps the current node in the normal conversation without changing the send target (running: %s)', async (running) => {
  if (running) useWorkspaceStore.setState({ runs: { source: { status: 'running', turns: [], systemEvents: [] } } })
  await mount()
  const input = container.querySelector('textarea')
  const notifications = useWorkspaceStore.getState().sessionNotifications
  const runs = useWorkspaceStore.getState().runs
  await act(async () => { node('source').click(); node('source').click() }); await settle()
  expect(onCurrentNodeClick).toHaveBeenCalledTimes(2)
  expect(onSelect).not.toHaveBeenCalled()
  expect(container.querySelector('[aria-label="当前会话对话"]')).not.toBeNull()
  expect(container.querySelector('[data-preview-session]')).toBeNull()
  expect(container.textContent).not.toContain('正在预览')
  expect(node('source').textContent).not.toContain('预览中')
  expect(container.querySelector('textarea')).toBe(input)
  expect(input?.parentElement?.inert).toBe(false)
  expect(input?.value).toBe('keep draft')
  expect(fetchSessionHistory).not.toHaveBeenCalled()
  expect(useWorkspaceStore.getState().sessionNotifications).toBe(notifications)
  expect(useWorkspaceStore.getState().runs).toBe(runs)
})
it('uses the current-node action instead of the reading-position return action when leaving another preview', async () => {
  await mount(); const input = container.querySelector('textarea')
  await act(async () => node('other').click()); await settle()
  await act(async () => node('source').click()); await settle()
  expect(onCurrentNodeClick).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[data-preview-session]')).toBeNull()
  expect(input?.parentElement?.inert).toBe(false)
  expect(onSelect).not.toHaveBeenCalled()
  expect(vi.mocked(fetchSessionHistory).mock.calls.map(([id]) => id)).toEqual(['other'])
})
it('keeps the normal conversation after an earlier preview branch finishes late', async () => {
  let finish!: () => void
  onBranch.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  await mount(); await act(async () => node('other').click()); await settle()
  await act(async () => button('从此轮后新建分支').click())
  await act(async () => node('source').click()); await settle()
  await act(async () => finish()); await settle()
  expect(container.querySelector('[data-preview-session]')).toBeNull()
  expect(container.querySelector('textarea')?.parentElement?.inert).toBe(false)
  expect(onSelect).not.toHaveBeenCalled()
})

const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === name)!
async function context(id: string) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 100 })
  await act(async () => node(id).dispatchEvent(event))
  return event
}
it('opens four actions on the right-clicked node without previewing, switching or reading history', async () => {
  await mount()
  expect((await context('other')).defaultPrevented).toBe(true)
  expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['切换到此处', '重命名', '克隆对话', '删除'])
  expect(onSelect).not.toHaveBeenCalled(); expect(fetchSessionHistory).not.toHaveBeenCalled()
  expect(container.querySelector('textarea')?.value).toBe('keep draft')
  await act(async () => menuItem('切换到此处').click()); await settle()
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('other')
  expect(container.querySelector('textarea')?.value).toBe('other draft')
  expect(container.querySelector('[aria-label="当前会话对话"]')?.getAttribute('aria-hidden')).toBe('false')
})
it('renames the context target through the existing dialog and returns focus to its node', async () => {
  await mount(); await context('other')
  await act(async () => menuItem('重命名').click()); await settle()
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
  expect(input.value).toBe('Other')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'New name')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await settle()
  expect(onRename).toHaveBeenCalledExactlyOnceWith('other', 'New name')
  expect(document.activeElement).toBe(node('other'))
  expect(onSelect).not.toHaveBeenCalled()
})
it('clones the context target and shows a failure without changing the current conversation', async () => {
  onClone.mockRejectedValueOnce(new Error('克隆失败，请重试'))
  await mount(); await context('other')
  await act(async () => menuItem('克隆对话').click()); await settle()
  expect(onClone).toHaveBeenCalledExactlyOnceWith('other')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('克隆失败')
  expect(onSelect).not.toHaveBeenCalled()
})
it('confirms deletion of the context target and closes its preview while retaining the child', async () => {
  onDelete.mockImplementation(async (id) => {
    vi.mocked(fetchSessionGraph).mockResolvedValue({ sessions: sessions.filter((session) => session.id !== id), branchStorage: { available: true } })
    await client.invalidateQueries({ queryKey: ['session-graph'] })
  })
  await mount(); await act(async () => node('other').click()); await settle()
  await context('other'); await act(async () => menuItem('删除').click())
  expect(onDelete).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Other')
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((button) => button.textContent === '删除会话')!.click()); await settle()
  expect(onDelete).toHaveBeenCalledExactlyOnceWith('other')
  expect(container.querySelector('[data-preview-session]')).toBeNull()
  expect(container.querySelector('[data-session-node="other"]')).toBeNull()
  expect(node('grandchild')).toBeTruthy()
  expect(onSelect).not.toHaveBeenCalled()
})
it('disables mutations for a running context target, while switching remains available', async () => {
  useWorkspaceStore.setState({ sessionNotifications: { other: { pendingRunId: 'running' } } })
  await mount(); await context('other')
  for (const name of ['重命名', '克隆对话', '删除']) expect(menuItem(name).hasAttribute('data-disabled')).toBe(true)
  expect(menuItem('切换到此处').hasAttribute('data-disabled')).toBe(false)
})
it.each(['storage', 'uncertain'] as const)('disables cloning with %s unavailable without disabling rename or delete', async (reason) => {
  if (reason === 'storage') vi.mocked(fetchSessionGraph).mockResolvedValue({ sessions, branchStorage: { available: false } })
  else useWorkspaceStore.getState().setBranchOperation('other', { operationId: 'uncertain', request: { kind: 'clone' } })
  await mount(); await context('other')
  expect(menuItem('克隆对话').hasAttribute('data-disabled')).toBe(true)
  expect(menuItem('重命名').hasAttribute('data-disabled')).toBe(false)
  expect(menuItem('删除').hasAttribute('data-disabled')).toBe(false)
})
it('does not capture menu pointer events as canvas panning through the portal', async () => {
  await mount(); await context('other')
  const viewport = container.querySelector<HTMLElement>('[aria-label="会话分支画布，方向键平移，点击节点查看会话"]')!
  const capture = vi.fn()
  Object.defineProperty(viewport, 'setPointerCapture', { value: capture })
  await act(async () => menuItem('重命名').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 })))
  expect(capture).not.toHaveBeenCalled()
  await act(async () => menuItem('重命名').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})
it('opens node actions from Shift+F10 without activating the node', async () => {
  await mount()
  await act(async () => node('other').dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })))
  expect(menuItem('切换到此处')).toBeTruthy()
  expect(onSelect).not.toHaveBeenCalled(); expect(fetchSessionHistory).not.toHaveBeenCalled()
})
it('closes a deleted preview even if refreshing the graph fails', async () => {
  onDelete.mockImplementation(async () => {
    vi.mocked(fetchSessionGraph).mockRejectedValueOnce(new Error('Read failed'))
    await client.invalidateQueries({ queryKey: ['session-graph'] })
  })
  await mount(); await act(async () => node('other').click()); await settle()
  await context('other'); await act(async () => menuItem('删除').click())
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((button) => button.textContent === '删除会话')!.click()); await settle()
  expect(onDelete).toHaveBeenCalledExactlyOnceWith('other')
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(container.querySelector('[data-preview-session]')).toBeNull()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('关联会话读取失败')
})
it('preserves a newer preview when an earlier clone fails late', async () => {
  let fail!: (error: Error) => void
  onClone.mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject }))
  await mount(); await context('other')
  await act(async () => menuItem('克隆对话').click())
  await act(async () => node('grandchild').click()); await settle()
  await act(async () => fail(new Error('Old clone failed')))
  expect(container.querySelector('[data-preview-session]')?.getAttribute('data-preview-session')).toBe('grandchild')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(onSelect).not.toHaveBeenCalled()
})
it('omits the graph banner and refresh row while retaining narrow-screen navigation', async () => {
  await mount()
  expect(container.textContent).not.toContain('独立会话分支 · 每个节点一个会话')
  expect(button('刷新树')).toBeUndefined()
  await act(async () => button('查看对话').click())
  expect(container.querySelector('[aria-label="当前会话对话"]')?.getAttribute('aria-hidden')).toBe('false')
  await act(async () => button('返回画布').click())
  expect(container.querySelector('[aria-label="当前会话对话"]')?.getAttribute('aria-hidden')).toBe('true')
})

async function renderTarget(sessionId: string, currentReadReady = false) {
  await act(async () => root.render(<QueryClientProvider client={client}><SessionGraphWorkspace enabled currentReadReady={currentReadReady} sessionId={sessionId} onPreview={() => {}} onCurrentNodeClick={onCurrentNodeClick} onSelect={onSelect} onBranch={onBranch} onRename={onRename} onClone={onClone} onDelete={onDelete} onRead={onRead}>
    <textarea aria-label="Existing draft" defaultValue="keep draft" />
  </SessionGraphWorkspace></QueryClientProvider>))
}

it('keeps cached family cards mounted while another current session in that family loads', async () => {
  await renderTarget('source'); await settle()
  const source = node('source')
  let finish!: (graph: Awaited<ReturnType<typeof fetchSessionGraph>>) => void
  vi.mocked(fetchSessionGraph).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await renderTarget('other'); await settle()
  expect(container.querySelectorAll('[data-session-node]')).toHaveLength(3)
  expect(node('source')).toBe(source)
  expect(node('other').getAttribute('aria-current')).toBe('true')
  await act(async () => finish({ sessions, branchStorage: { available: true } })); await settle()
  expect(node('source')).toBe(source)
})

it('does not show an unrelated family while its new graph loads or fails, and permits retry', async () => {
  await renderTarget('source'); await settle()
  let fail!: (cause: Error) => void
  vi.mocked(fetchSessionGraph).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  await renderTarget('unrelated'); await settle()
  expect(container.querySelectorAll('[data-session-node]')).toHaveLength(0)
  expect(container.textContent).toContain('正在读取关联会话')
  await act(async () => fail(new Error('Read failed'))); await settle()
  expect(container.querySelectorAll('[data-session-node]')).toHaveLength(0)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('关联会话读取失败')
  vi.mocked(fetchSessionGraph).mockResolvedValueOnce({ sessions: [{ id: 'unrelated', cwd: '/w' }], branchStorage: { available: true } })
  await act(async () => button('重试').click()); await settle()
  expect(node('unrelated')).toBeTruthy()
  expect(node('source')).toBeNull()
})

it('retains another branch fold when the current session changes inside the same family', async () => {
  const family = [...sessions, { id: 'parallel', name: 'Parallel', cwd: '/w', parentSessionId: 'source' }]
  vi.mocked(fetchSessionGraph).mockResolvedValue({ sessions: family, branchStorage: { available: true } })
  await renderTarget('source'); await settle()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="折叠 Other 的子会话"]')!.click())
  expect(node('grandchild')).toBeNull()
  await renderTarget('parallel'); await settle()
  expect(node('grandchild')).toBeNull()
  expect(container.querySelector('[aria-label="展开 Other 的子会话"]')?.getAttribute('aria-expanded')).toBe('false')
  expect(node('parallel').getAttribute('aria-current')).toBe('true')
})

it('clears the completed badge after only the read notification changes without changing the completed run', async () => {
  useWorkspaceStore.setState({ runs: { other: { status: 'complete', turns: [], systemEvents: [] } }, sessionNotifications: { other: { completedRunId: 'done' } } })
  await mount()
  expect(node('other').textContent).toContain('✓ 已完成')
  const runs = useWorkspaceStore.getState().runs
  await act(async () => useWorkspaceStore.getState().markSessionRead('other', 'done')); await settle()
  expect(node('other').textContent).not.toContain('已完成')
  expect(useWorkspaceStore.getState().runs).toBe(runs)
  expect(useWorkspaceStore.getState().runs.other.status).toBe('complete')
})

it('shows a persisted unread completion even when the runtime run has not been restored', async () => {
  useWorkspaceStore.setState({ sessionNotifications: { other: { completedRunId: 'restored', readRunId: 'older' } } })
  await mount()
  expect(node('other').textContent).toContain('✓ 已完成')
  await act(async () => useWorkspaceStore.getState().markSessionRead('other', 'restored')); await settle()
  expect(node('other').textContent).not.toContain('已完成')
})

it.each([
  ['running', '● 推理中'], ['error', '× 请求失败'], ['aborted', '— 已中止'],
] as const)('shows %s ahead of an older unread completion', async (status, label) => {
  useWorkspaceStore.setState({ runs: { other: { status, turns: [], systemEvents: [] } }, sessionNotifications: { other: { completedRunId: 'older' } } })
  await mount()
  expect(node('other').textContent).toContain(label)
  expect(node('other').textContent).not.toContain('已完成')
})

it('marks a preview completion read only after its requested history is successfully displayed', async () => {
  useWorkspaceStore.setState({ runs: { other: { status: 'complete', turns: [], systemEvents: [] } }, sessionNotifications: { other: { completedRunId: 'done' } } })
  let finish!: (history: Awaited<ReturnType<typeof fetchSessionHistory>>) => void
  vi.mocked(fetchSessionHistory).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await mount()
  await act(async () => node('other').click()); await settle()
  expect(onRead).not.toHaveBeenCalled()
  expect(node('other').textContent).toContain('✓ 已完成')
  await act(async () => finish({ session: { id: 'other' }, revision: 'r', entries: [{ id: 'answer', parentId: null, type: 'message', timestamp: '', raw: { message: { role: 'assistant', content: 'Read answer' } } }], hasEarlier: false })); await settle(); await settle()
  expect(container.querySelector('[data-preview-session="other"]')?.getAttribute('data-entries')).toBe('1')
  expect(onRead).toHaveBeenCalledExactlyOnceWith('other', 'done')
  expect(useWorkspaceStore.getState().sessionNotifications.other.readRunId).toBe('done')
  expect(node('other').textContent).not.toContain('已完成')
  expect(useWorkspaceStore.getState().runs.other.status).toBe('complete')
  expect(onSelect).not.toHaveBeenCalled()
})

it('keeps a failed preview unread', async () => {
  useWorkspaceStore.setState({ runs: { other: { status: 'complete', turns: [], systemEvents: [] } }, sessionNotifications: { other: { completedRunId: 'done' } } })
  vi.mocked(fetchSessionHistory).mockRejectedValueOnce(new Error('History unavailable'))
  await mount(); await act(async () => node('other').click()); await settle(); await settle()
  expect(fetchSessionHistory).toHaveBeenCalled()
  expect(onRead).not.toHaveBeenCalled()
  expect(useWorkspaceStore.getState().sessionNotifications.other.readRunId).toBeUndefined()
  expect(node('other').textContent).toContain('✓ 已完成')
})

it('does not mark an unread completion read when opening node actions or its rename dialog', async () => {
  useWorkspaceStore.setState({ runs: { other: { status: 'complete', turns: [], systemEvents: [] } }, sessionNotifications: { other: { completedRunId: 'done' } } })
  await mount(); await context('other')
  await act(async () => menuItem('重命名').click()); await settle()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(fetchSessionHistory).not.toHaveBeenCalled()
  expect(onRead).not.toHaveBeenCalled()
  expect(useWorkspaceStore.getState().sessionNotifications.other.readRunId).toBeUndefined()
  expect(node('other').textContent).toContain('✓ 已完成')
})

it('keeps a ready current conversation unread while the narrow layout shows only the canvas', async () => {
  useWorkspaceStore.setState({ runs: { source: { status: 'complete', turns: [], systemEvents: [] } }, sessionNotifications: { source: { completedRunId: 'done' } } })
  await renderTarget('source', true); await settle(); await settle()
  expect(onRead).not.toHaveBeenCalled()
  expect(node('source').textContent).toContain('已完成')
  await act(async () => button('查看对话').click()); await settle(); await settle()
  expect(onRead).toHaveBeenCalledExactlyOnceWith('source', 'done')
  expect(node('source').textContent).not.toContain('已完成')
})

it.each(['current', 'preview'] as const)('waits for the file sheet to close before acknowledging the %s reader', async (mode) => {
  useWorkspaceStore.setState({ sessionNotifications: { source: { completedRunId: 'current-done' }, other: { completedRunId: 'preview-done' } } })
  const selection = mode === 'preview' ? { sessionId: 'other' } : undefined
  const render = (readBlocked: boolean) => act(async () => root.render(<QueryClientProvider client={client}><SessionGraphWorkspace
    enabled sessionId="source" selection={selection} currentReadReady readBlocked={readBlocked} onRead={onRead}
    onPreview={() => {}} onCurrentNodeClick={onCurrentNodeClick} onSelect={onSelect} onBranch={onBranch} onRename={onRename} onClone={onClone} onDelete={onDelete}>
    <p>Current conversation</p>
  </SessionGraphWorkspace></QueryClientProvider>))
  await render(true); await settle(); await settle()
  await act(async () => button('查看对话').click()); await settle(); await settle()
  expect(onRead).not.toHaveBeenCalled()
  await render(false); await settle(); await settle()
  expect(onRead).toHaveBeenCalledExactlyOnceWith(mode === 'current' ? 'source' : 'other', `${mode}-done`)
})
