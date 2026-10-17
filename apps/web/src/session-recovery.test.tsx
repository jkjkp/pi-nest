// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspacePage } from './workspace-page.js'
import { useWorkspaceStore } from './workspace-store.js'
import { sessionHistoryQueryKey } from './history.js'
import { deleteSession, fetchSessions, fetchSessionHistory, fetchSessionTurnIndex } from './workspace-api.js'
import { useWorkspaceSession } from './use-workspace-session.js'
import type { SessionRunController } from './session-run-controller.js'

vi.mock('./workspace-api.js', async (original) => ({
  ...await original<typeof import('./workspace-api.js')>(),
  fetchProjects: vi.fn(async () => []),
  deleteSession: vi.fn(), fetchSessions: vi.fn(), fetchSessionHistory: vi.fn(), fetchSessionTurnIndex: vi.fn(),
}))
const one = { id: 'one', cwd: '/fixture', name: '已有会话' }
const history = { session: one, revision: 'fixed', hasEarlier: false, entries: [{ id: 'old-user', parentId: null, timestamp: '2026-10-17T00:00:00Z', type: 'message', raw: { message: { role: 'user', content: '已经加载的历史' } } }] }
let client: QueryClient
let root: Root
let container: HTMLDivElement
const controller = { openSession: vi.fn(), releaseForeground: vi.fn(), getCommands: vi.fn(async () => []), stop: vi.fn(async () => true) } as unknown as SessionRunController
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200)
  vi.mocked(fetchSessions).mockReset()
  vi.mocked(fetchSessionHistory).mockReset().mockResolvedValue(history)
  vi.mocked(fetchSessionTurnIndex).mockReset().mockResolvedValue({ revision: 'fixed', entries: [] })
  vi.mocked(controller.openSession).mockClear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useWorkspaceStore.setState({ drafts: { one: '未发送草稿' }, runs: { one: { status: 'running', turns: [], systemEvents: [], pendingInputs: [] } }, runtimeDetails: { one: { isCompacting: false, isStreaming: true, model: { provider: 'fixture', id: 'model' } } }, runtimeStates: { one: { lifecycle: 'active', revision: 1 } }, watchStates: { one: 'ready' }, hiddenProjectCwds: {}, collapsedProjectKeys: {}, navigationOrder: { projectOrder: [], sessionOrderByProject: {} } })
})
afterEach(async () => { await act(() => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function LocationProbe() { return <output data-testid="route">{useLocation().search}</output> }
async function mount() { await act(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?session=one']}><WorkspacePage sessionRuns={controller} /><LocationProbe /></MemoryRouter></QueryClientProvider>)) }
async function settle() { await act(async () => { await new Promise((done) => setTimeout(done, 10)) }) }

it('reads and watches the selected session while its list is still loading', async () => {
  let release!: (value: typeof one[]) => void
  vi.mocked(fetchSessions).mockImplementation(() => new Promise((done) => { release = done }))
  await mount(); await settle()
  expect(fetchSessionHistory).toHaveBeenCalledWith('one', undefined, undefined, expect.any(AbortSignal))
  expect(controller.openSession).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('已经加载的历史')
  expect(container.textContent).not.toContain('选择一个会话')
  const turn = container.querySelector('article')
  await act(() => release([one])); await settle()
  expect(container.querySelector('article')).toBe(turn)
  expect(controller.openSession).toHaveBeenCalledTimes(1)
  expect(container.querySelector('textarea')?.value).toBe('未发送草稿')
})

it.each(['missing', 'error'])('keeps the selected route, readable timeline and stop control on list %s', async (result) => {
  client.setQueryData(sessionHistoryQueryKey('one'), { pages: [history], pageParams: [{}] })
  let release!: () => void
  vi.mocked(fetchSessions).mockImplementation(() => new Promise((resolve, reject) => {
    release = () => result === 'missing' ? resolve([{ id: 'other', cwd: '/fixture', name: '另一个会话' }]) : reject(new Error('list failed'))
  }))
  await mount()
  const turn = container.querySelector('article')
  await act(() => release()); await settle()
  expect(container.querySelector('[data-testid="route"]')?.textContent).toBe('?session=one')
  expect(container.querySelector('article')).toBe(turn)
  expect(container.textContent).toContain('已经加载的历史')
  expect(container.textContent).not.toContain('选择一个会话')
  expect(container.querySelector('[aria-label="停止生成"]')).not.toBeNull()
  expect(container.querySelector('textarea')?.value).toBe('未发送草稿')
  expect(container.textContent).toContain('重试会话列表')
})

it('shows recovery rather than an unselected workspace before any data arrives', async () => {
  vi.mocked(fetchSessions).mockImplementation(() => new Promise(() => {}))
  vi.mocked(fetchSessionHistory).mockImplementation(() => new Promise(() => {}))
  await mount()
  expect(container.textContent).toContain('正在恢复会话')
  expect(container.textContent).not.toContain('从左侧选择一个会话')
  expect(container.querySelector('[data-testid="route"]')?.textContent).toBe('?session=one')
})

it.each([true, false])('changes selection after confirmed deletion (another session exists: %s)', async (hasOther) => {
  const other = { id: 'other', cwd: '/fixture', name: 'Next' }
  client.setQueryData(['sessions'], hasOther ? [one, other] : [one])
  vi.mocked(fetchSessions).mockResolvedValue(hasOther ? [other] : [])
  vi.mocked(deleteSession).mockResolvedValue(undefined)
  let workspace!: ReturnType<typeof useWorkspaceSession>
  function Probe() {
    // oxlint-disable-next-line react/globals -- Capture the mounted mutation API.
    workspace = useWorkspaceSession(controller)
    return <LocationProbe />
  }
  await act(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?session=one']}><Probe /></MemoryRouter></QueryClientProvider>))
  await act(async () => { await workspace.handleDelete('one') }); await settle()
  expect(container.querySelector('[data-testid="route"]')?.textContent).toBe(hasOther ? '?session=other' : '')
  expect(client.getQueryData<typeof one[]>(['sessions'])).toEqual(hasOther ? [other] : [])
  if (!hasOther) expect(controller.releaseForeground).toHaveBeenCalled()
})
