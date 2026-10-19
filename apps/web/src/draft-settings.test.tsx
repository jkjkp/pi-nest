// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkspaceSession } from './use-workspace-session.js'
import { useWorkspaceStore } from './workspace-store.js'
import { createSession } from './workspace-api.js'
import type { SessionRunController } from './session-run-controller.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), createSession: vi.fn() }))
const probe = {} as { workspace: ReturnType<typeof useWorkspaceSession> }
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
const element = document.createElement('div')
const root = createRoot(element)
const controller = { adopt: vi.fn(), openSession: vi.fn(), releaseForeground: vi.fn() } as unknown as SessionRunController
const models = [
  { provider: 'test', id: 'reasoning', name: 'Reasoning', thinkingLevels: ['off', 'high'] },
  { provider: 'test', id: 'plain', name: 'Plain', thinkingLevels: ['off'] },
]
function Probe() {
  const workspace = useWorkspaceSession(controller)
  useEffect(() => { probe.workspace = workspace }, [workspace])
  return null
}
afterEach(async () => { await act(() => root.render(null)); client.clear(); vi.clearAllMocks(); vi.unstubAllGlobals() })
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useWorkspaceStore.setState({ runs: {}, drafts: {}, hiddenProjectCwds: {}, collapsedProjectKeys: {}, watchStates: {}, runtimeStates: {}, runtimeDetails: {}, navigationOrder: { projectOrder: [], sessionOrderByProject: {} } })
  client.setQueryData(['sessions'], [])
  client.setQueryData(['projects'], [{ cwd: '/a' }, { cwd: '/b' }])
  for (const cwd of ['/a', '/b']) client.setQueryData(['draft-configuration', cwd], { models, settings: { effective: { defaultProvider: 'test', defaultModel: 'reasoning', defaultThinkingLevel: 'high' } } })
  await act(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?draftProject=cwd%3A%2Fa']}><Probe /></MemoryRouter></QueryClientProvider>))
}
it('keeps choices per project and resets unsupported thinking levels when changing models', async () => {
  await mount()
  expect(probe.workspace.currentModel?.id).toBe('reasoning')
  expect(probe.workspace.currentThinkingLevel).toBe('high')
  await act(async () => { await probe.workspace.changeModel('test', 'plain') })
  expect(probe.workspace.currentThinkingLevel).toBe('off')
  expect(probe.workspace.thinkingLevels).toEqual(['off'])
  await act(() => probe.workspace.startDraft(probe.workspace.projects.find((project) => project.cwd === '/b')!))
  expect(probe.workspace.currentModel?.id).toBe('reasoning')
  await act(() => probe.workspace.startDraft(probe.workspace.projects.find((project) => project.cwd === '/a')!))
  expect(probe.workspace.currentModel?.id).toBe('plain')
  expect(createSession).not.toHaveBeenCalled()
})
it('sends the chosen model and level with the first prompt and retains both after failure', async () => {
  await mount()
  await act(async () => { await probe.workspace.changeThinkingLevel('off'); probe.workspace.setDraftPrompt('first prompt') })
  vi.mocked(createSession).mockRejectedValueOnce(new Error('初始化失败'))
  await act(async () => { probe.workspace.submitPrompt(); await Promise.resolve() })
  expect(createSession).toHaveBeenCalledWith('/a', 'first prompt', undefined, { model: { provider: 'test', id: 'reasoning' }, thinkingLevel: 'off' })
  expect(probe.workspace.prompt).toBe('first prompt')
  expect(probe.workspace.currentThinkingLevel).toBe('off')
  expect(probe.workspace.draftError).toBe('初始化失败')
  expect(controller.adopt).not.toHaveBeenCalled()
})
