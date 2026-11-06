import { seedWorkspaceProjects } from '../src/test-fixtures/workspace.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { PiEditLastInput, PiSessionHistoryResponse } from '@pi-nest/contracts'
import { WorkspacePage } from '../src/workspace-page.js'
import { TooltipProvider } from '../src/components/ui/tooltip.js'
import { createSessionRunController } from '../src/session-run-controller.js'
import { useWorkspaceStore } from '../src/workspace-store.js'
import { replaceSessionHistory } from '../src/history-view.js'
import { sessionHistoryQueryKey } from '../src/history.js'
import { runtimeFixture } from './runtime-fixture.js'

/** Browser-only fixture; all requests remain synthetic and use the production workspace. */
export function sessionEditFixture() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  const session = { id: 'edit-smoke', cwd: '/fixture', name: '编辑重发验证' }
  const timestamp = new Date().toISOString()
  let calls = 0
  function history(id: string, question: string, answer: string): PiSessionHistoryResponse {
    return { session, revision: id === 'old-user' ? 'a'.repeat(64) : calls.toString(16).padStart(64, '0'), hasEarlier: false, entries: [
      { id, parentId: null, timestamp, type: 'message', raw: { type: 'message', message: { role: 'user', content: question } } },
      { id: `${id}-answer`, parentId: id, timestamp, type: 'message', raw: { type: 'message', message: { role: 'assistant', content: answer, stopReason: 'stop' } } },
    ] }
  }
  let page = history('old-user', '请解释登录流程', '这是旧回答，编辑时仍可阅读。')
  const fetchOriginal = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const path = String(input)
    if (path === '/api/sessions') return Response.json({ sessions: [session] })
    if (path === '/api/projects') return Response.json({ projects: [] })
    if (path.includes('/api/sessions/edit-smoke/history')) return Response.json(page)
    if (path.includes('/api/sessions/edit-smoke/turn-index')) return Response.json({ revision: page.revision, entries: [{ id: page.entries[0]!.id, index: 1, promptPreview: '登录流程', startedAt: timestamp }] })
    if (path.startsWith('/api/')) throw new Error(`Unexpected fixture request: ${path}`)
    return fetchOriginal(input, init)
  }
  client.setQueryData(['sessions'], [session])
  seedWorkspaceProjects(client)
  seedWorkspaceProjects(client)
  client.setQueryData(sessionHistoryQueryKey(session.id), { pages: [page], pageParams: [{}] })
  useWorkspaceStore.setState({ messageEdits: {}, runs: {}, drafts: { [session.id]: '普通草稿保留' }, runtimeStates: {}, runtimeDetails: {}, watchStates: {}, sessionNotifications: {}, legacyHiddenProjectCwds: {} })
  const transport = runtimeFixture()
  const runtime = { ...transport, getCommands: async () => [], getRuntimeState: async () => ({ isCompacting: false, isStreaming: false }),
    editLast: async (_sessionId: string, input: PiEditLastInput) => {
      calls++
      const userEntryId = `new-user-${calls}`
      page = history(userEntryId, input.message, '这是根据修改后的问题生成的新回答。')
      transport.emit(session.id, { type: 'history_changed', change: { id: `new-position-${calls}`, entryId: input.entryId, revision: page.revision, sequence: calls } })
      return { status: 'committed', submissionId: input.submissionId, userEntryId }
    },
  }
  const controller = createSessionRunController({ runtime: runtime as never, replaceHistory: (id, change) => replaceSessionHistory(client, id, change), invalidateHistory: (id) => client.invalidateQueries({ queryKey: sessionHistoryQueryKey(id) }) })
  return {
    element: <QueryClientProvider client={client}><MemoryRouter initialEntries={['/?session=edit-smoke']}><TooltipProvider><WorkspacePage sessionRuns={controller} /></TooltipProvider></MemoryRouter></QueryClientProvider>,
    snapshot: () => ({ calls, page, draft: useWorkspaceStore.getState().drafts[session.id], edit: useWorkspaceStore.getState().messageEdits[session.id] }),
  }
}
