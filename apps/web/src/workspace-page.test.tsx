import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'

import { WorkspacePage } from './workspace-page.js'
import { useWorkspaceStore } from './workspace-store.js'

const sessionRuns = {
  adopt: () => undefined,
  compact: async () => undefined,
  followUp: async () => undefined,
  getAvailableModels: async () => [],
  getAvailableThinkingLevels: async () => [],
  getRuntimeState: async () => ({ isCompacting: false, isStreaming: false }),
  openSession: () => undefined,
  releaseForeground: () => undefined,
  resume: () => undefined,
  resumeRuntime: async () => undefined,
  setModel: async () => undefined,
  setThinkingLevel: async () => undefined,
  start: () => false,
  steer: async () => undefined,
  stop: async () => false,
}

describe('WorkspacePage new conversation draft', () => {
  it('renders a project-bound draft without inventing a sidebar session', () => {
    useWorkspaceStore.setState({ hiddenProjectCwds: {}, runs: {}, watchStates: {} })
    const queryClient = new QueryClient()
    queryClient.setQueryData(['sessions'], [{ cwd: '/work/pi-nest', firstMessage: '已有会话', id: 'session-1', updatedAt: '2026-09-24T00:00:00.000Z' }])

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/?draftProject=cwd%3A%2Fwork%2Fpi-nest']}><WorkspacePage sessionRuns={sessionRuns} /></MemoryRouter>
      </QueryClientProvider>,
    )

    expect(markup).toContain('在 pi-nest 开始新对话')
    expect(markup).toContain('发送第一条消息后才会创建 Pi 会话。')
    expect(markup).not.toContain('未命名会话')
  })
})
