import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { WorkspacePage } from '../src/workspace-page.js'
import { createSessionRunController } from '../src/session-run-controller.js'
import { useWorkspaceStore } from '../src/workspace-store.js'
import { sessionHistoryQueryKey, sessionTurnIndexQueryKey } from '../src/history.js'
import { runtimeFixture } from './runtime-fixture.js'
import { TooltipProvider } from '../src/components/ui/tooltip.js'

/** The production workspace with cached synthetic history and the real event controller. */
export function workspaceSmoke() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  const sessions = [{ id: 'smoke-a', cwd: '/fixture', name: 'Smoke A' }, { id: 'smoke-b', cwd: '/fixture', name: 'Smoke B' }]
  client.setQueryData(['projects'], [])
  client.setQueryData(['sessions'], sessions)
  const timestamp = new Date().toISOString()
  for (const session of sessions) {
    client.setQueryData(sessionHistoryQueryKey(session.id), { pages: [{ session, entries: [], revision: 'smoke', hasEarlier: false }], pageParams: [{}] })
    client.setQueryData(sessionTurnIndexQueryKey(session.id, 'smoke'), { entries: [], revision: 'smoke' })
  }
  useWorkspaceStore.setState({ runs: {}, drafts: {}, sessionNotifications: {}, navigationOrder: { projectOrder: [], sessionOrderByProject: {} }, hiddenProjectCwds: {}, collapsedProjectKeys: {}, runtimeStates: {}, runtimeDetails: {}, watchStates: {} })
  const runtime = runtimeFixture()
  const controller = createSessionRunController({ runtime: runtime as never, invalidateHistory: async () => {} })
  const sources: Record<string, string> = {}
  return {
    element: <QueryClientProvider client={client}><MemoryRouter initialEntries={['/?session=smoke-a']}><TooltipProvider><WorkspacePage sessionRuns={controller} /></TooltipProvider></MemoryRouter></QueryClientProvider>,
    start: async () => {
      for (const session of sessions) controller.start({ sessionId: session.id, prompt: 'synthetic replay' })
      for (let i = 0; i < 12; i++) await Promise.resolve()
      for (const session of sessions) {
        runtime.emit(session.id, { type: 'agent_start' })
        runtime.emit(session.id, { type: 'message_start', message: { id: `user:${session.id}`, role: 'user', content: 'synthetic replay' } })
      }
    },
    snapshot: () => ({ drafts: useWorkspaceStore.getState().drafts, runs: Object.fromEntries(Object.entries(useWorkspaceStore.getState().runs).map(([id, run]) => [id, run.status])) }),
    append: (id: string, delta: string) => {
      sources[id] = (sources[id] ?? '') + delta
      runtime.emit(id, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
    },
    finish: (id: string, reason: 'stop' | 'error' | 'aborted' = 'stop') => {
      runtime.emit(id, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: sources[id] ?? '' }], stopReason: reason } })
      runtime.emit(id, { type: 'agent_settled', aborted: reason === 'aborted' })
    },
    publishHistory: (id: string) => {
      const session = sessions.find((value) => value.id === id)!
      const entries = [
        { id: `user:${id}`, type: 'message', timestamp, raw: { type: 'message', message: { role: 'user', content: 'synthetic replay' } } },
        { id: `answer:${id}`, type: 'message', timestamp, raw: { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: sources[id] }], stopReason: 'stop' } } },
      ]
      client.setQueryData(sessionTurnIndexQueryKey(id, 'smoke-v2'), { entries: [], revision: 'smoke-v2' })
      client.setQueryData(sessionHistoryQueryKey(id), { pages: [{ session, entries, revision: 'smoke-v2', hasEarlier: false }], pageParams: [{}] })
    },
  }
}
