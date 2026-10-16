// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspaceSession } from './use-workspace-session.js'
import { useWorkspaceStore } from './workspace-store.js'
import { fetchSessionHistory, fetchSessionTurnIndex, RequestError } from './workspace-api.js'
import { sessionHistoryQueryKey, type PiSessionHistoryResponse } from './history.js'
import type { SessionRunController } from './session-run-controller.js'
import { WorkspacePage } from './workspace-page.js'
import { timelineItems } from './timeline-model.js'

vi.mock('./workspace-api.js', async (original) => ({
  ...await original<typeof import('./workspace-api.js')>(),
  fetchSessionHistory: vi.fn(), fetchSessionTurnIndex: vi.fn(),
}))

const session = { id: 'one', cwd: '/fixture', name: 'One' }
const history: PiSessionHistoryResponse = {
  session, revision: 'old', hasEarlier: false,
  entries: [{ id: 'old-user', parentId: null, timestamp: '2026-10-16T00:00:00Z', type: 'message', raw: { type: 'message', message: { role: 'user', content: 'previous question' } } }],
}
let root: Root
let client: QueryClient
let container: HTMLDivElement
let workspace: ReturnType<typeof useWorkspaceSession>
const controller = { openSession: vi.fn(), releaseForeground: vi.fn(), getCommands: vi.fn(async () => []), stop: vi.fn(async () => true) } as unknown as SessionRunController
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(fetchSessionHistory).mockReset().mockResolvedValue(history)
  vi.mocked(fetchSessionTurnIndex).mockReset().mockResolvedValue({ entries: [], revision: 'old' })
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  client.setQueryData(['sessions'], [session])
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useWorkspaceStore.setState({ drafts: { one: 'draft' }, runs: {}, runtimeDetails: { one: { isStreaming: false, isCompacting: false, model: { provider: 'fixture', id: 'model' } } }, runtimeStates: { one: { lifecycle: 'idle', revision: 1 } }, watchStates: { one: 'ready' }, hiddenProjectCwds: {}, collapsedProjectKeys: {}, navigationOrder: { projectOrder: [], sessionOrderByProject: {} } })
})
afterEach(async () => { await act(() => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function Probe() {
  // oxlint-disable-next-line react/globals -- Capture the real mounted hook for lifecycle assertions.
  workspace = useWorkspaceSession(controller)
  return null
}
async function mount(page = false) {
  await act(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?session=one']}>{page ? <WorkspacePage sessionRuns={controller} /> : <Probe />}</MemoryRouter></QueryClientProvider>))
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) }) }
function running() {
  const store = useWorkspaceStore.getState()
  store.setRun('one', { status: 'running', turns: [{ id: 'live-user', prompt: 'current question', startedAt: '2026-10-16T00:00:01Z', events: [] }], systemEvents: [], pendingInputs: [] })
  store.setRuntimeState('one', { lifecycle: 'active', revision: 2 })
}
async function finish() {
  await act(() => {
    const store = useWorkspaceStore.getState()
    store.updateRun('one', { status: 'complete' })
    store.setRuntimeState('one', { lifecycle: 'idle', revision: 3 })
    void client.invalidateQueries({ queryKey: sessionHistoryQueryKey('one') })
  })
  await settle()
}

it('defers all history reads while running without a cache and resumes after settling', async () => {
  running()
  await mount()
  expect(fetchSessionHistory).not.toHaveBeenCalled()
  expect(fetchSessionTurnIndex).not.toHaveBeenCalled()
  expect(workspace.historyNotice).toBe('任务进行中，结束后同步历史')
  expect(workspace.historyError).toBe(false)
  workspace.retryHistory(); workspace.loadEarlier(); workspace.retryNavigation()
  await expect(workspace.readTurnPrompt('old-user', undefined)).rejects.toThrow('当前任务结束')
  expect(fetchSessionHistory).not.toHaveBeenCalled()
  await finish()
  expect(fetchSessionHistory).toHaveBeenCalledTimes(1)
  expect(workspace.history?.revision).toBe('old')
  expect(workspace.historyNotice).toBeUndefined()
  expect(useWorkspaceStore.getState().runs.one?.turns[0]?.prompt).toBe('current question')
  expect(useWorkspaceStore.getState().drafts.one).toBe('draft')
})

it('also defers reads for a runtime active snapshot before replay reconstructs its turn', async () => {
  useWorkspaceStore.getState().setRuntimeState('one', { lifecycle: 'active', revision: 2 })
  await mount()
  expect(fetchSessionHistory).not.toHaveBeenCalled()
  expect(workspace.historyPaused).toBe(true)
  expect(workspace.historyNotice).toBeDefined()
})

it('waits for a runtime snapshot when the watch acknowledgement arrives first', async () => {
  useWorkspaceStore.setState({ runtimeStates: {} })
  await mount()
  expect(fetchSessionHistory).not.toHaveBeenCalled()
  await act(() => running())
  expect(fetchSessionHistory).not.toHaveBeenCalled()
})

it('retains cached history during invalidation and synchronizes the latest snapshot after completion', async () => {
  client.setQueryData<InfiniteData<PiSessionHistoryResponse>>(sessionHistoryQueryKey('one'), { pages: [history], pageParams: [{}] })
  running()
  await mount()
  await act(() => { void client.invalidateQueries({ queryKey: sessionHistoryQueryKey('one') }) })
  expect(fetchSessionHistory).not.toHaveBeenCalled()
  expect(workspace.history?.entries[0]?.id).toBe('old-user')
  expect(workspace.historyNotice).toBeUndefined()
  vi.mocked(fetchSessionHistory).mockResolvedValue({ ...history, revision: 'new', entries: [...history.entries,
    { id: 'live-user', parentId: 'old-user', timestamp: '2026-10-16T00:00:01Z', type: 'message', raw: { type: 'message', message: { role: 'user', content: 'current question' } } },
    { id: 'answer', parentId: 'live-user', timestamp: '2026-10-16T00:00:02Z', type: 'message', raw: { type: 'message', message: { role: 'assistant', content: 'completed answer', stopReason: 'stop' } } },
  ] })
  vi.mocked(fetchSessionTurnIndex).mockResolvedValue({ entries: [], revision: 'new' })
  await finish()
  expect(workspace.history?.revision).toBe('new')
  expect(workspace.historyError).toBe(false)
  const items = timelineItems(workspace.history?.entries, workspace.currentRun?.turns ?? [], [])
  expect(items.filter((item) => item.prompt === 'current question')).toHaveLength(1)
  expect(items.flatMap((item) => item.parts).filter((part) => part.kind === 'assistant_text' && part.text === 'completed answer')).toHaveLength(1)
})

it('treats an unexpected SESSION_RUNNING conflict as deferred, without retrying until completion', async () => {
  vi.mocked(fetchSessionHistory).mockRejectedValueOnce(new RequestError(409, 'SESSION_RUNNING'))
  await mount(); await settle()
  expect(workspace.historyQuery.isError).toBe(true)
  expect(workspace.historyError).toBe(false)
  expect(workspace.historyNotice).toBeDefined()
  expect(fetchSessionHistory).toHaveBeenCalledTimes(1)
  await act(() => running())
  await finish()
  expect(fetchSessionHistory).toHaveBeenCalledTimes(2)
  expect(workspace.historyNotice).toBeUndefined()
})

it('cancels an in-flight history read when generation starts and preserves the live turn', async () => {
  let resolve!: (value: PiSessionHistoryResponse) => void
  vi.mocked(fetchSessionHistory).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  await mount()
  const signal = vi.mocked(fetchSessionHistory).mock.calls[0]![3]!
  await act(() => running())
  expect(signal.aborted).toBe(true)
  await act(() => resolve(history))
  expect(workspace.historyError).toBe(false)
  expect(workspace.history).toBeUndefined()
  expect(useWorkspaceStore.getState().runs.one?.status).toBe('running')
  await finish()
  expect(workspace.history?.revision).toBe('old')
})

it.each([new RequestError(500), new RequestError(409, 'REVISION_CHANGED')])('keeps real history failures visible: %s', async (error) => {
  vi.mocked(fetchSessionHistory).mockRejectedValueOnce(error)
  await mount(); await settle()
  expect(workspace.historyError).toBe(true)
  expect(workspace.historyNotice).toBeUndefined()
})

it('retains a readable cached page when the completion refresh fails', async () => {
  client.setQueryData<InfiniteData<PiSessionHistoryResponse>>(sessionHistoryQueryKey('one'), { pages: [history], pageParams: [{}] })
  running(); await mount()
  vi.mocked(fetchSessionHistory).mockRejectedValueOnce(new RequestError(500))
  await finish()
  expect(workspace.history?.entries[0]?.id).toBe('old-user')
  expect(workspace.historyError).toBe(true)
  expect(useWorkspaceStore.getState().runs.one?.turns[0]?.prompt).toBe('current question')
})

it('allows a stable history snapshot while the runtime is waiting for extension input', async () => {
  running()
  useWorkspaceStore.getState().updateRun('one', { status: 'awaiting_input' })
  await mount(); await settle()
  expect(fetchSessionHistory).toHaveBeenCalledTimes(1)
  expect(workspace.historyPaused).toBe(false)
})

it('renders a waiting notice alongside the live turn rather than the red history failure', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200)
  running()
  await mount(true)
  expect(container.textContent).toContain('任务进行中，结束后同步历史')
  expect(container.textContent).toContain('current question')
  expect(container.textContent).not.toContain('无法读取会话历史')
  expect(container.querySelector('textarea')?.value).toBe('draft')
  expect(container.querySelector('[aria-label="停止生成"]')).not.toBeNull()
  expect(fetchSessionHistory).not.toHaveBeenCalled()
})
