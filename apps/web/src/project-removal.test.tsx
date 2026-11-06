// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspaceSession } from './use-workspace-session.js'
import { useWorkspaceStore } from './workspace-store.js'
import { fetchProjects, removeProject } from './workspace-api.js'
import { fixtureProject } from './test-fixtures/workspace.js'
import type { SessionRunController } from './session-run-controller.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), fetchProjects: vi.fn(), removeProject: vi.fn(), fetchSessionHistory: vi.fn(async (id) => ({ session: { id }, entries: [], revision: 'fixture', hasEarlier: false })), fetchSessionTurnIndex: vi.fn(async () => ({ entries: [], revision: 'fixture' })) }))
let root: Root
let client: QueryClient
let element: HTMLDivElement
let workspace: ReturnType<typeof useWorkspaceSession>
let serverProjects = [fixtureProject('/a'), fixtureProject('/b')]
const controller = { openSession: vi.fn(), releaseForeground: vi.fn() } as unknown as SessionRunController
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  serverProjects = [fixtureProject('/a'), fixtureProject('/b')]
  vi.mocked(fetchProjects).mockImplementation(async () => serverProjects)
  vi.mocked(removeProject).mockReset().mockImplementation(async (id) => { serverProjects = serverProjects.filter((project) => project.id !== id) })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['projects'], serverProjects)
  client.setQueryData(['sessions'], [{ id: 'a-session', cwd: '/a', projectId: '/a' }, { id: 'b-session', cwd: '/b', projectId: '/b' }])
  useWorkspaceStore.setState({ runs: {}, drafts: {}, legacyHiddenProjectCwds: {}, navigationOrder: { projectOrder: [], sessionOrderByProject: {} }, runtimeStates: {}, watchStates: {} })
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
afterEach(async () => { await act(() => root.unmount()); client.clear(); element.remove(); vi.unstubAllGlobals() })
function Probe() {
  const value = useWorkspaceSession(controller)
  useEffect(() => { workspace = value }, [value])
  return null
}
async function mount() { await act(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?session=a-session']}><Probe /></MemoryRouter></QueryClientProvider>)) }
it('uses server removal, keeps raw sessions, and preserves a later navigation while the request is pending', async () => {
  let finish!: () => void
  vi.mocked(removeProject).mockImplementationOnce(async (id) => { await new Promise<void>((resolve) => { finish = resolve }); serverProjects = serverProjects.filter((project) => project.id !== id) })
  await mount()
  let removing!: Promise<void>
  await act(() => { removing = workspace.removeProject(workspace.projects.find((project) => project.id === '/a')!) })
  expect(workspace.projects).toHaveLength(2)
  await act(() => workspace.selectSession('b-session'))
  await act(async () => { finish(); await removing })
  expect(client.getQueryData(['projects'])).toEqual([fixtureProject('/b')])
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  expect(removeProject).toHaveBeenCalledExactlyOnceWith('/a')
  expect(workspace.selectedSessionId).toBe('b-session')
  expect(workspace.projects.map((project) => project.id)).toEqual(['/b'])
  expect(client.getQueryData(['sessions'])).toHaveLength(2)
  expect(controller.releaseForeground).not.toHaveBeenCalled()
})
it('keeps projects and navigation after a failed removal', async () => {
  vi.mocked(removeProject).mockRejectedValueOnce(new Error('数据库不可用'))
  await mount()
  await act(async () => { await expect(workspace.removeProject(workspace.projects[0]!)).rejects.toThrow('数据库不可用') })
  expect(workspace.projects).toHaveLength(2)
  expect(workspace.selectedSessionId).toBe('a-session')
})
