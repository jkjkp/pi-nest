import type { ComponentProps } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { PendingInputs, WorkspacePage } from './workspace-page.js'
import { useWorkspaceStore } from './workspace-store.js'

const composer = vi.hoisted(() => ({ canQuery: false }))
vi.mock('./command-composer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./command-composer.js')>()
  return { CommandComposer: (props: ComponentProps<typeof original.CommandComposer>) => {
    composer.canQuery = props.canQuery
    return <original.CommandComposer {...props} />
  } }
})

vi.mock('./workspace-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./workspace-store.js')>()
  const store = original.useWorkspaceStore
  return { ...original, useWorkspaceStore: Object.assign((selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState()), store) }
})

const sessionRuns = {
  adopt: () => undefined,
  compact: async () => undefined,
  followUp: async () => undefined,
  getCommands: async () => [],
  getAvailableModels: async () => [],
  getAvailableThinkingLevels: async () => [],
  getSessionStatistics: async () => undefined,
  getRuntimeState: async () => ({ isCompacting: false, isStreaming: false }),
  openSession: () => undefined,
  releaseForeground: () => undefined,
  resume: () => undefined,
  resumeRuntime: async () => undefined,
  setModel: async () => undefined,
  setThinkingLevel: async () => undefined,
  start: () => false,
  steer: async () => undefined,
  steerQueued: async () => undefined,
  retrySteering: async () => undefined,
  stop: async () => false,
}

it('offers default queueing and the steering shortcut while preserving the stop button', () => {
  useWorkspaceStore.setState({ drafts: { 'session-1': 'next task' }, runs: { 'session-1': { status: 'running', turns: [], systemEvents: [], pendingInputs: [] } }, runtimeStates: {}, watchStates: {} })
  const queryClient = new QueryClient()
  queryClient.setQueryData(['sessions'], [{ id: 'session-1', cwd: '/fixture' }])
  const markup = renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/?session=session-1']}><WorkspacePage sessionRuns={sessionRuns} /></MemoryRouter></QueryClientProvider>)
  expect(markup).not.toContain('>引导</button>')
  expect(markup).toContain('>排队</button>')
  expect(markup).toContain('Enter 排队，Ctrl + Enter 引导，Shift + Enter 换行')
  expect(markup).toContain('aria-label="停止生成"')
  queryClient.clear()
})

it('limits the pending list to two rows and reports additional messages', () => {
  const markup = renderToStaticMarkup(<PendingInputs inputs={[
    { id: 'a', message: 'first', mode: 'follow_up', submittedAt: 'now' },
    { id: 'b', message: 'later', mode: 'follow_up', submittedAt: 'now' },
    { id: 'c', message: 'hidden task', mode: 'follow_up', submittedAt: 'now' },
  ]} onSteer={() => undefined} />)
  expect(markup).not.toContain('引导待生效')
  expect(markup).toContain('已排队')
  expect(markup).toContain('还有 1 条')
  expect(markup).toContain('>引导</button>')
  expect(markup).not.toContain('hidden task')
})

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
    expect(markup).toContain('pointer-events-none absolute inset-0 z-10 overflow-hidden')
    expect(markup).toContain('relative h-full w-full')
    expect(markup).toContain('data-slot="composer"')
    expect(markup).toContain('timeline-scroll h-full')
    expect(markup).toContain('pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-transparent')
    expect(markup).toContain('pb-[calc(var(--composer-height)+3rem)]')
    expect(markup).not.toContain('shadow-[0_16px_32px')
  })
})

it('keeps runtime loading feedback in the header instead of inserting a timeline paragraph', () => {
  useWorkspaceStore.setState({ hiddenProjectCwds: {}, runs: {}, watchStates: {}, runtimeStates: { 'session-1': { lifecycle: 'loading', revision: 1 } }, runtimeDetails: {}, runtimeStatistics: {} })
  const queryClient = new QueryClient()
  queryClient.setQueryData(['sessions'], [{ cwd: '/work/pi-nest', id: 'session-1', name: 'Loading session' }])
  const markup = renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/?session=session-1']}><WorkspacePage sessionRuns={sessionRuns} /></MemoryRouter></QueryClientProvider>)
  expect(markup).toContain('aria-label="正在加载 Pi 运行时"')
  expect(markup).not.toContain('>正在加载 Pi 运行时<')
  queryClient.clear()
})

it('keeps the English Plan status as a detail trigger without displaying its internal widget', () => {
  useWorkspaceStore.setState({ hiddenProjectCwds: {}, runs: {}, watchStates: {}, runtimeStates: {}, extensionStatuses: { 'session-1': { 'plan-mode': 'plan active ●', ponytail: 'ponytail: FULL' } }, extensionWidgets: { 'session-1': { 'plan-mode-plan': ['Plan mode: planning', 'Finish with plan_mode_complete when decision-ready.'], todos: ['Other extension progress'] } } })
  const queryClient = new QueryClient()
  queryClient.setQueryData(['sessions'], [{ cwd: '/work/pi-nest', id: 'session-1', name: 'Plan session' }])
  const markup = renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/?session=session-1']}><WorkspacePage sessionRuns={sessionRuns} /></MemoryRouter></QueryClientProvider>)
  expect(markup).toContain('plan active ●')
  expect(markup).toContain('查看 Plan 模式详情')
  expect(markup).toContain('Other extension progress')
  expect(markup).toContain('ponytail: FULL')
  expect(markup).not.toContain('Plan mode: planning')
  expect(markup).not.toContain('Finish with plan_mode_complete')
  queryClient.clear()
})

it('allows command discovery when an idle watched session already has a model from its snapshot', () => {
  useWorkspaceStore.setState({
    drafts: { 'session-1': '/p' }, runs: {}, hiddenProjectCwds: {},
    runtimeStates: { 'session-1': { lifecycle: 'idle', revision: 1 } },
    runtimeDetails: { 'session-1': { isCompacting: false, isStreaming: false, model: { provider: 'fixture', id: 'model' } } },
    watchStates: { 'session-1': 'ready' },
  })
  const queryClient = new QueryClient()
  queryClient.setQueryData(['sessions'], [{ id: 'session-1', cwd: '/fixture' }])
  renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/?session=session-1']}><WorkspacePage sessionRuns={sessionRuns} /></MemoryRouter></QueryClientProvider>)
  expect(composer.canQuery).toBe(true)
  queryClient.clear()
})
