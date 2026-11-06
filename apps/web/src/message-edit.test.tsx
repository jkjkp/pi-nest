import { seedWorkspaceProjects } from './test-fixtures/workspace.js'
// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { expect, it, vi } from 'vitest'
import type { SessionRunController } from './session-run-controller.js'
import { useWorkspaceSession } from './use-workspace-session.js'
import { useWorkspaceStore } from './workspace-store.js'
import { sessionHistoryQueryKey } from './history.js'
import { RuntimeConnectionError } from './runtime-websocket-client.js'
import { fetchProjects, fetchSessions, fetchSessionHistory, fetchSessionTurnIndex } from './workspace-api.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), fetchProjects: vi.fn(), fetchSessions: vi.fn(), fetchSessionHistory: vi.fn(), fetchSessionTurnIndex: vi.fn() }))

it.each([false, true])('isolates edit and ordinary drafts, and queries a lost ACK without resending (%s)', async (lostAck) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  const timestamp = '2026-11-02T00:00:00Z'
  const page = { session: { id: 'session-1' }, revision: 'a'.repeat(64), hasEarlier: false, entries: [{ id: 'user', parentId: null, type: 'message', timestamp, raw: { message: { role: 'user', content: 'Original full question' } } }] }
  vi.mocked(fetchProjects).mockResolvedValue([])
  vi.mocked(fetchSessions).mockResolvedValue([page.session])
  vi.mocked(fetchSessionHistory).mockResolvedValue(page)
  vi.mocked(fetchSessionTurnIndex).mockResolvedValue({ revision: page.revision, entries: [{ id: 'user', index: 1, promptPreview: 'Original', startedAt: timestamp }] })
  client.setQueryData(['sessions'], [page.session])
  seedWorkspaceProjects(client)
  seedWorkspaceProjects(client)
  client.setQueryData(sessionHistoryQueryKey('session-1'), { pages: [page], pageParams: [{}] })
  useWorkspaceStore.setState({ runs: {}, drafts: { 'session-1': 'Unsent ordinary draft' }, messageEdits: {}, runtimeStates: {}, runtimeDetails: {}, watchStates: {} })
  const controller = { openSession: vi.fn(), releaseForeground: vi.fn(), editLast: vi.fn(), getEditStatus: vi.fn() } as unknown as SessionRunController
  vi.mocked(controller.editLast).mockImplementation(async (_id, input) => {
    if (lostAck) throw new RuntimeConnectionError('Disconnected')
    return { status: 'committed', submissionId: input.submissionId, userEntryId: 'new-user' }
  })
  vi.mocked(controller.getEditStatus).mockImplementation(async (_id, submissionId) => ({ status: 'committed', submissionId, userEntryId: 'new-user' }))
  let workspace!: ReturnType<typeof useWorkspaceSession>
  function Probe() {
    const api = useWorkspaceSession(controller)
    useEffect(() => { workspace = api }, [api])
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?session=session-1']}><Probe /></MemoryRouter></QueryClientProvider>))
    await act(() => workspace.beginMessageEdit('user'))
    expect(workspace.prompt).toBe('Original full question')
    await act(() => workspace.setDraft('session-1', 'Temporary edit'))
    await act(() => workspace.cancelMessageEdit())
    expect(workspace.prompt).toBe('Unsent ordinary draft')
    await act(() => workspace.beginMessageEdit('user'))
    await act(() => workspace.setDraft('session-1', 'Edited question'))
    await act(() => workspace.submitMessageEdit())
    if (lostAck) {
      expect(workspace.messageEdit?.status).toBe('unknown')
      await act(() => workspace.submitMessageEdit())
      expect(controller.getEditStatus).toHaveBeenCalledOnce()
    }
    expect(controller.editLast).toHaveBeenCalledOnce()
    expect(vi.mocked(controller.editLast).mock.calls[0]![1]).toMatchObject({ entryId: 'user', message: 'Edited question', revision: page.revision })
    expect(workspace.messageEdit).toBeUndefined()
    expect(workspace.prompt).toBe('Unsent ordinary draft')
  } finally {
    await act(() => root.unmount())
    client.clear(); container.remove(); useWorkspaceStore.setState({ messageEdits: {} }); vi.unstubAllGlobals()
  }
})
