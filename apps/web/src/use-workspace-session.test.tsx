import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { expect, it, vi } from 'vitest'
import type { SessionRunController } from './session-run-controller.js'
import { fetchSessionHistory } from './workspace-api.js'
import { useWorkspaceSession } from './use-workspace-session.js'
import { useWorkspaceStore } from './workspace-store.js'

vi.mock('./workspace-api.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./workspace-api.js')>()
  return { ...original, fetchSessionHistory: vi.fn() }
})

vi.mock('./workspace-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./workspace-store.js')>()
  const store = original.useWorkspaceStore
  return { ...original, useWorkspaceStore: Object.assign((selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), store) }
})

it('finishes each runtime control read before starting the next one', async () => {
  let release!: () => void
  const stateRead = new Promise<void>((resolve) => { release = resolve })
  const controller = {
    resumeRuntime: vi.fn(async () => undefined),
    getRuntimeState: vi.fn(async () => { await stateRead; const details = { isCompacting: false, isStreaming: false }; useWorkspaceStore.getState().setRuntimeDetails('session-1', details); return details }),
    getAvailableModels: vi.fn(async () => []),
    getAvailableThinkingLevels: vi.fn(async () => []),
  } as unknown as SessionRunController
  const queryClient = new QueryClient()
  queryClient.setQueryData(['sessions'], [{ id: 'session-1', cwd: '/fixture' }])
  useWorkspaceStore.setState({ runs: {}, watchStates: {}, runtimeStates: {} })
  const probe: { workspace?: ReturnType<typeof useWorkspaceSession> } = {}
  function Probe() {
    // Capture the server-rendered hook API to exercise its async operations without a DOM.
    // oxlint-disable-next-line react/immutability
    probe.workspace = useWorkspaceSession(controller)
    return null
  }
  renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/?session=session-1']}><Probe /></MemoryRouter></QueryClientProvider>)
  const loading = probe.workspace!.openModels()
  await probe.workspace!.openModels()
  expect(controller.resumeRuntime).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(controller.getRuntimeState).toHaveBeenCalledWith('session-1'))
  expect(controller.getAvailableModels).not.toHaveBeenCalled()
  expect(controller.getAvailableThinkingLevels).not.toHaveBeenCalled()
  release()
  await loading
  expect(controller.getAvailableModels).toHaveBeenCalledWith('session-1')
  expect(controller.getAvailableThinkingLevels).not.toHaveBeenCalled()
  await probe.workspace!.openModels()
  expect(controller.getAvailableModels).toHaveBeenCalledTimes(1)
  await probe.workspace!.openModels(true)
  expect(controller.getAvailableModels).toHaveBeenCalledTimes(2)
  useWorkspaceStore.getState().clearRuntimeState('session-1')
  await probe.workspace!.openModels()
  expect(controller.getAvailableModels).toHaveBeenCalledTimes(3)
  queryClient.clear()
})

function thinkingProbe(prompt = '', active = false) {
  useWorkspaceStore.setState({ runs: active ? { 'session-1': { status: 'running', turns: [], pendingInputs: [], systemEvents: [] } } : {}, drafts: { 'session-1': prompt }, runtimeDetails: { 'session-1': { isCompacting: false, isStreaming: false, model: { provider: 'test', id: 'model' }, thinkingLevel: 'medium' } }, runtimeStates: {}, watchStates: {} })
  const controller = {
    resumeRuntime: vi.fn(async () => undefined),
    getAvailableThinkingLevels: vi.fn(async () => ['off', 'medium', 'high']),
    setThinkingLevel: vi.fn(async (_id, _level) => { useWorkspaceStore.getState().setRuntimeDetails('session-1', { isCompacting: false, isStreaming: false, thinkingLevel: 'medium' }) }),
    getRuntimeState: vi.fn(async () => useWorkspaceStore.getState().runtimeDetails['session-1']!),
    start: vi.fn(() => true), steer: vi.fn(), followUp: vi.fn(),
  } as unknown as SessionRunController
  const queryClient = new QueryClient()
  queryClient.setQueryData(['sessions'], [{ id: 'session-1', cwd: '/fixture' }])
  let workspace!: ReturnType<typeof useWorkspaceSession>
  function Probe() {
    // oxlint-disable-next-line react/globals -- Capture the hook API for this isolated server-rendered test.
    workspace = useWorkspaceSession(controller)
    return null
  }
  renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/?session=session-1']}><Probe /></MemoryRouter></QueryClientProvider>)
  return { workspace, controller, queryClient }
}

it('validates Pi levels and uses the confirmed value instead of the requested one', async () => {
  const { workspace, controller, queryClient } = thinkingProbe()
  expect(await workspace.changeThinkingLevel('invalid')).toBe(false)
  expect(controller.setThinkingLevel).not.toHaveBeenCalled()
  expect(await workspace.changeThinkingLevel('high')).toBe(true)
  expect(controller.setThinkingLevel).toHaveBeenCalledWith('session-1', 'high')
  expect(useWorkspaceStore.getState().runtimeDetails['session-1']?.thinkingLevel).toBe('medium')
  queryClient.clear()
})

it('does not submit thinking commands as model prompts or queued inputs', async () => {
  const { workspace, controller, queryClient } = thinkingProbe('/thinking high')
  workspace.submitPrompt()
  await vi.waitFor(() => expect(controller.setThinkingLevel).toHaveBeenCalledWith('session-1', 'high'))
  expect(controller.start).not.toHaveBeenCalled()
  expect(controller.steer).not.toHaveBeenCalled()
  expect(controller.followUp).not.toHaveBeenCalled()
  queryClient.clear()
})

it('rejects duplicate thinking changes and preserves input when Pi fails', async () => {
  const { workspace, controller, queryClient } = thinkingProbe('/thinking high')
  let reject!: (error: Error) => void
  vi.mocked(controller.setThinkingLevel).mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const first = workspace.changeThinkingLevel('high')
  await vi.waitFor(() => expect(controller.setThinkingLevel).toHaveBeenCalledTimes(1))
  expect(await workspace.changeThinkingLevel('medium')).toBe(false)
  reject(new Error('Pi rejected thinking change'))
  expect(await first).toBe(false)
  expect(useWorkspaceStore.getState().drafts['session-1']).toBe('/thinking high')
  queryClient.clear()
})

it('blocks thinking commands during generation without queuing or clearing input', async () => {
  const { workspace, controller, queryClient } = thinkingProbe('/thinking high', true)
  workspace.submitPrompt()
  expect(await workspace.changeThinkingLevel('high')).toBe(false)
  expect(controller.resumeRuntime).not.toHaveBeenCalled()
  expect(controller.setThinkingLevel).not.toHaveBeenCalled()
  expect(controller.steer).not.toHaveBeenCalled()
  expect(controller.followUp).not.toHaveBeenCalled()
  expect(useWorkspaceStore.getState().drafts['session-1']).toBe('/thinking high')
  queryClient.clear()
})

it('shares history page reads between full previews and unloaded jumps without truncating text', async () => {
  const { workspace, queryClient } = thinkingProbe()
  const text = '用户原始消息'.repeat(40) + '\n完整末行'
  vi.mocked(fetchSessionHistory).mockReset().mockResolvedValue({
    entries: [{ id: 'user-1', parentId: null, type: 'message', timestamp: '2026-10-12T00:00:00Z', raw: { message: { role: 'user', content: text } } }],
    hasEarlier: false, revision: 'fixture', session: { id: 'session-1', cwd: '/fixture' },
  })
  const previews = await Promise.all([workspace.readTurnPrompt('user-1', 'user-2'), workspace.readTurnPrompt('user-1', 'user-2')])
  expect(previews).toEqual([text, text])
  await workspace.jumpToUnloadedTurn('user-1', 'user-2')
  expect(fetchSessionHistory).toHaveBeenCalledTimes(1)
  expect(queryClient.getQueryData(['session-history', 'session-1', 'branch-v2'])).toHaveProperty('pages')
  await expect(workspace.readTurnPrompt('missing', 'user-2')).rejects.toThrow('未找到用户消息')
  queryClient.clear()
})

it('ignores an older unloaded jump after a newer node was selected', async () => {
  const { workspace, queryClient } = thinkingProbe()
  let release!: (page: Awaited<ReturnType<typeof fetchSessionHistory>>) => void
  const page = (id: string) => ({ entries: [{ id, parentId: null, type: 'message', timestamp: '2026-10-12T00:00:00Z', raw: { message: { role: 'user', content: id } } }], hasEarlier: false, revision: 'fixture', session: { id: 'session-1', cwd: '/fixture' } })
  vi.mocked(fetchSessionHistory).mockReset().mockImplementationOnce(() => new Promise((resolve) => { release = resolve })).mockResolvedValueOnce(page('user-2'))
  const older = workspace.jumpToUnloadedTurn('user-1', 'cursor-1')
  await workspace.jumpToUnloadedTurn('user-2', 'cursor-2')
  release(page('user-1'))
  await older
  const cached = queryClient.getQueryData<{ pages: Awaited<ReturnType<typeof fetchSessionHistory>>[] }>(['session-history', 'session-1', 'branch-v2'])!
  expect(cached.pages.flatMap((item) => item.entries.map((entry) => entry.id))).toEqual(['user-2'])
  queryClient.clear()
})
