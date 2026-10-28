import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { expect, it, vi } from 'vitest'
import type { SessionRunController } from './session-run-controller.js'
import { branchSession, fetchSessionHistory } from './workspace-api.js'
import { useWorkspaceSession } from './use-workspace-session.js'
import { useWorkspaceStore } from './workspace-store.js'

vi.mock('./workspace-api.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./workspace-api.js')>()
  return { ...original, branchSession: vi.fn(), fetchSessionHistory: vi.fn() }
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
  useWorkspaceStore.setState({ runs: active ? { 'session-1': { status: 'running', turns: [], pendingInputs: [], systemEvents: [] } } : {}, drafts: { 'session-1': prompt }, runtimeDetails: { 'session-1': { isCompacting: false, isStreaming: false, model: { provider: 'test', id: 'model' }, thinkingLevel: 'medium' } }, runtimeStates: { 'session-1': { lifecycle: 'idle', revision: 1 } }, watchStates: { 'session-1': 'ready' } })
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

it.each(['/thinking', '/thinking high', '/model', '/model fixture/model'])('submits %s as text without switching settings', (prompt) => {
  const { workspace, controller, queryClient } = thinkingProbe(prompt)
  workspace.submitPrompt()
  expect(controller.start).toHaveBeenCalledWith(expect.objectContaining({ prompt, sessionId: 'session-1' }))
  expect(controller.setThinkingLevel).not.toHaveBeenCalled()
  expect(controller.getAvailableThinkingLevels).not.toHaveBeenCalled()
  queryClient.clear()
})

it('rejects duplicate thinking changes and preserves input when Pi fails', async () => {
  const { workspace, controller, queryClient } = thinkingProbe('保留草稿')
  let reject!: (error: Error) => void
  vi.mocked(controller.setThinkingLevel).mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const first = workspace.changeThinkingLevel('high')
  await vi.waitFor(() => expect(controller.setThinkingLevel).toHaveBeenCalledTimes(1))
  expect(await workspace.changeThinkingLevel('medium')).toBe(false)
  reject(new Error('Pi rejected thinking change'))
  expect(await first).toBe(false)
  expect(useWorkspaceStore.getState().drafts['session-1']).toBe('保留草稿')
  queryClient.clear()
})

it('blocks thinking changes during generation without clearing the draft', async () => {
  const { workspace, controller, queryClient } = thinkingProbe('保留草稿', true)
  expect(await workspace.changeThinkingLevel('high')).toBe(false)
  expect(controller.resumeRuntime).not.toHaveBeenCalled()
  expect(controller.setThinkingLevel).not.toHaveBeenCalled()
  expect(useWorkspaceStore.getState().drafts['session-1']).toBe('保留草稿')
  queryClient.clear()
})

it('shares the settings operation lock with prompt submission and branching', async () => {
  const { workspace, controller, queryClient } = thinkingProbe('保留草稿')
  vi.mocked(branchSession).mockClear()
  let acknowledge!: () => void
  vi.mocked(controller.setThinkingLevel).mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve }))
  const changing = workspace.changeThinkingLevel('high')
  await vi.waitFor(() => expect(controller.setThinkingLevel).toHaveBeenCalledTimes(1))
  workspace.submitPrompt()
  await expect(workspace.createBranch({ kind: 'clone' })).rejects.toThrow('请等待')
  expect(controller.start).not.toHaveBeenCalled()
  expect(branchSession).not.toHaveBeenCalled()
  expect(useWorkspaceStore.getState().drafts['session-1']).toBe('保留草稿')
  acknowledge()
  expect(await changing).toBe(true)
  workspace.submitPrompt()
  expect(controller.start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', prompt: '保留草稿' }))
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

it('queues supplemental instructions by default and only steers explicitly', async () => {
  const { workspace, controller, queryClient } = thinkingProbe('补充说明', true)
  vi.mocked(controller.followUp).mockResolvedValue(undefined)
  workspace.submitPrompt()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().drafts['session-1']).toBe(''))
  expect(controller.followUp).toHaveBeenCalledWith('session-1', '补充说明')
  expect(controller.steer).not.toHaveBeenCalled()
  vi.mocked(controller.steer).mockResolvedValue(undefined)
  workspace.submitPrompt('steer')
  await vi.waitFor(() => expect(controller.steer).toHaveBeenCalledWith('session-1', '补充说明'))
  expect(workspace).not.toHaveProperty('queueMode')
  queryClient.clear()
})

it('prevents duplicate submissions and keeps a newly edited draft during acknowledgement', async () => {
  const { workspace, controller, queryClient } = thinkingProbe('排队消息', true)
  let acknowledge!: () => void
  vi.mocked(controller.followUp).mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve }))
  workspace.submitPrompt()
  workspace.submitPrompt()
  workspace.submitPrompt('steer')
  expect(controller.followUp).toHaveBeenCalledTimes(1)
  expect(controller.steer).not.toHaveBeenCalled()
  useWorkspaceStore.getState().setDraft('session-1', '下一条草稿')
  acknowledge()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(useWorkspaceStore.getState().drafts['session-1']).toBe('下一条草稿')
  queryClient.clear()
})

it('retains the draft if a running input fails', async () => {
  const { workspace, controller, queryClient } = thinkingProbe('不能丢失', true)
  vi.mocked(controller.followUp).mockRejectedValue(new Error('Failed'))
  workspace.submitPrompt()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(useWorkspaceStore.getState().drafts['session-1']).toBe('不能丢失')
  queryClient.clear()
})

it('clears a steering draft immediately and preserves new typing while it is sent', async () => {
  const { workspace, controller, queryClient } = thinkingProbe('引导内容', true)
  let acknowledge!: () => void
  vi.mocked(controller.steer).mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve }))
  workspace.submitPrompt('steer')
  expect(useWorkspaceStore.getState().drafts['session-1']).toBe('')
  useWorkspaceStore.getState().setDraft('session-1', '新的草稿')
  acknowledge()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(useWorkspaceStore.getState().drafts['session-1']).toBe('新的草稿')
  queryClient.clear()
})

it('adds a native branch to the session cache and restores the selected message only as a child draft', async () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['sessions'], [{ id: 'source', cwd: '/fixture', name: 'Original' }])
  useWorkspaceStore.setState({ drafts: { source: '/fork' }, runs: {}, runtimeStates: {}, watchStates: {} })
  const result = { session: { id: 'child', cwd: '/fixture' }, draft: '完整问题\n继续编辑' }
  vi.mocked(branchSession).mockResolvedValueOnce(result)
  const probe: { workspace?: ReturnType<typeof useWorkspaceSession> } = {}
  function Probe() {
    // oxlint-disable-next-line react/immutability -- Capture the server-rendered hook for an async operation test.
    probe.workspace = useWorkspaceSession({} as SessionRunController)
    return null
  }
  renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/?session=source']}><Probe /></MemoryRouter></QueryClientProvider>)
  await expect(probe.workspace!.createBranch({ kind: 'fork', entryId: 'u', revision: 'a'.repeat(64) })).resolves.toEqual(result)
  expect(branchSession).toHaveBeenCalledWith('source', { kind: 'fork', entryId: 'u', revision: 'a'.repeat(64) })
  expect(queryClient.getQueryData(['sessions'])).toEqual([result.session, { id: 'source', cwd: '/fixture', name: 'Original' }])
  expect(useWorkspaceStore.getState().drafts.child).toBe('完整问题\n继续编辑')
  expect(useWorkspaceStore.getState().drafts.source).toBe('/fork')
  queryClient.clear()
})

it('clones an idle background session while the selected session runs, blocks duplicates, and allows retry after failure', async () => {
  vi.mocked(branchSession).mockReset()
  const queryClient = new QueryClient()
  queryClient.setQueryData(['sessions'], [{ id: 'source', cwd: '/fixture' }, { id: 'other', cwd: '/fixture' }])
  useWorkspaceStore.setState({ drafts: { source: '保留草稿', other: '未发送' }, sessionNotifications: {}, runs: { source: { status: 'running', turns: [], systemEvents: [], pendingInputs: [] } }, runtimeStates: {}, watchStates: {} })
  const probe: { workspace?: ReturnType<typeof useWorkspaceSession> } = {}
  function Probe() {
    // oxlint-disable-next-line react/immutability -- Capture the hook API for async operation checks.
    probe.workspace = useWorkspaceSession({} as SessionRunController)
    return null
  }
  renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/?session=source']}><Probe /></MemoryRouter></QueryClientProvider>)
  await expect(probe.workspace!.createBranch({ kind: 'clone' }, 'source')).rejects.toThrow('请等待')
  let reject!: (cause: Error) => void
  vi.mocked(branchSession).mockImplementationOnce(() => new Promise((_, rejectPromise) => { reject = rejectPromise }))
  const pending = probe.workspace!.createBranch({ kind: 'clone' }, 'other')
  await expect(probe.workspace!.createBranch({ kind: 'clone' }, 'other')).rejects.toThrow('请等待')
  expect(branchSession).toHaveBeenCalledExactlyOnceWith('other', { kind: 'clone' })
  reject(new Error('克隆失败'))
  await expect(pending).rejects.toThrow('克隆失败')
  const result = { session: { id: 'child', cwd: '/fixture', parentSessionId: 'other' }, draft: '' }
  vi.mocked(branchSession).mockResolvedValueOnce(result)
  await expect(probe.workspace!.createBranch({ kind: 'clone' }, 'other')).resolves.toEqual(result)
  expect(queryClient.getQueryData(['sessions'])).toEqual([result.session, { id: 'source', cwd: '/fixture' }, { id: 'other', cwd: '/fixture' }])
  expect(useWorkspaceStore.getState().drafts).toMatchObject({ source: '保留草稿', other: '未发送', child: '' })
  queryClient.clear()
})
