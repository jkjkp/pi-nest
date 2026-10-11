import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { expect, it, vi } from 'vitest'
import type { SessionRunController } from './session-run-controller.js'
import { useWorkspaceSession } from './use-workspace-session.js'
import { useWorkspaceStore } from './workspace-store.js'

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
