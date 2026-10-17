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

it('loads history and navigation during generation, including before runtime replay', async () => {
  running()
  await mount(); await settle()
  expect(fetchSessionHistory).toHaveBeenCalledTimes(1)
  expect(fetchSessionTurnIndex).toHaveBeenCalledWith('one', 'old', expect.any(AbortSignal))
  expect(workspace.history?.entries[0]?.id).toBe('old-user')
  await expect(workspace.readTurnPrompt('old-user')).resolves.toBe('previous question')
  expect(workspace.historyError).toBe(false)
})

it('reads history without waiting for a runtime snapshot', async () => {
  useWorkspaceStore.setState({ runtimeStates: {} })
  await mount(); await settle()
  expect(workspace.history?.revision).toBe('old')
})

it('does not cancel an in-flight history request when generation starts', async () => {
  let resolve!: (value: PiSessionHistoryResponse) => void
  vi.mocked(fetchSessionHistory).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  await mount()
  const signal = vi.mocked(fetchSessionHistory).mock.calls[0]![3]!
  await act(() => running())
  expect(signal.aborted).toBe(false)
  await act(() => resolve(history)); await settle()
  expect(workspace.history?.revision).toBe('old')
  expect(workspace.currentRun?.status).toBe('running')
})

it('paginates and previews old turns while generation continues, and stops at the oldest page', async () => {
  const latest = { ...history, hasEarlier: true, beforeCursor: 'old-user' }
  vi.mocked(fetchSessionHistory).mockResolvedValueOnce(latest).mockResolvedValue(history)
  running(); await mount(); await settle()
  expect(workspace.historyQuery.hasPreviousPage).toBe(true)
  await act(async () => { workspace.loadEarlier(); await new Promise((done) => setTimeout(done, 10)) }); await settle()
  expect(fetchSessionHistory).toHaveBeenLastCalledWith('one', 'old-user', 'old', expect.any(AbortSignal))
  expect(workspace.historyQuery.hasPreviousPage).toBe(false)
  await expect(workspace.readTurnPrompt('old-user', 'old-user')).resolves.toBe('previous question')
  expect(workspace.currentRun?.status).toBe('running')
})

it('retains the loaded range until its replacement is complete and merges by run identity', async () => {
  const older = { ...history, entries: [{ ...history.entries[0]!, id: 'older-user', timestamp: '2026-10-15T00:00:00Z' }] }
  client.setQueryData<InfiniteData<PiSessionHistoryResponse>>(sessionHistoryQueryKey('one'), { pages: [older, history], pageParams: [{}, {}] })
  running(); await mount()
  useWorkspaceStore.getState().updateRun('one', { turns: [{ ...workspace.currentRun!.turns[0]!, runId: 'current-run' }] })
  const native = { ...history.entries[0]!, id: 'native-user', runId: 'current-run', runIndex: 0, timestamp: '2026-10-16T00:00:01Z', raw: { type: 'message', message: { role: 'user', content: 'current question' } } }
  let release!: (value: PiSessionHistoryResponse) => void
  vi.mocked(fetchSessionHistory).mockImplementation(async (_id, before) => before ? new Promise((done) => { release = done }) : { ...history, revision: 'new', hasEarlier: true, beforeCursor: 'native-user', entries: [native] })
  vi.mocked(fetchSessionTurnIndex).mockResolvedValue({ entries: [{ id: 'older-user', startedAt: older.entries[0]!.timestamp, promptPreview: 'older', index: 1 }], revision: 'new' })
  await act(() => { void client.invalidateQueries({ queryKey: sessionHistoryQueryKey('one') }) }); await settle()
  expect(workspace.history?.revision).toBe('old')
  expect(workspace.history?.entries.map((entry) => entry.id)).toEqual(['older-user', 'old-user'])
  await act(() => release({ ...older, revision: 'new', entries: [...older.entries, ...history.entries] })); await settle()
  expect(workspace.history?.revision).toBe('new')
  expect(workspace.history?.entries.map((entry) => entry.id)).toEqual(['older-user', 'old-user', 'native-user'])
  expect(timelineItems(workspace.history?.entries, workspace.currentRun?.turns ?? [], []).filter((item) => item.prompt === 'current question')).toHaveLength(1)
  expect(useWorkspaceStore.getState().drafts.one).toBe('draft')
})

it.each([new RequestError(500), new RequestError(409, 'HISTORY_SNAPSHOT_EXPIRED')])('keeps actual read failures visible and retryable: %s', async (error) => {
  vi.mocked(fetchSessionHistory).mockRejectedValueOnce(error)
  running(); await mount(); await settle()
  expect(workspace.historyError).toBe(true)
  await act(() => workspace.retryHistory()); await settle()
  expect(workspace.historyError).toBe(false)
  expect(workspace.history?.revision).toBe('old')
})

it('retains readable cached pages when completion refresh fails', async () => {
  client.setQueryData<InfiniteData<PiSessionHistoryResponse>>(sessionHistoryQueryKey('one'), { pages: [history], pageParams: [{}] })
  running(); await mount()
  vi.mocked(fetchSessionHistory).mockRejectedValueOnce(new RequestError(500))
  await finish()
  expect(workspace.history?.entries[0]?.id).toBe('old-user')
  expect(workspace.historyError).toBe(true)
})

it('renders old history alongside live output without a waiting notice', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200)
  running(); await mount(true); await settle()
  expect(container.textContent).toContain('previous question')
  expect(container.textContent).toContain('current question')
  expect(container.textContent).not.toContain('任务进行中，结束后同步历史')
  expect(container.textContent).not.toContain('无法读取会话历史')
  expect(container.querySelector('textarea')?.value).toBe('draft')
  expect(container.querySelector('[aria-label="停止生成"]')).not.toBeNull()
})
