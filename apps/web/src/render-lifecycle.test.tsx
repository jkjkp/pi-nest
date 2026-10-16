// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router'
import { RenderErrorBoundary } from './render-error-boundary.js'
import { RouteErrorPage } from './route-error-page.js'
import { WorkspacePage } from './workspace-page.js'
import * as timeline from './session-timeline.js'
import { TurnExecution } from './turn-execution.js'
import { useWorkspaceStore } from './workspace-store.js'
import { sessionHistoryQueryKey, sessionTurnIndexQueryKey } from './history.js'
import type { SessionRunController } from './session-run-controller.js'
import type { TimelineItem } from './timeline-model.js'
import type { PiRuntimeState } from '@pi-nest/contracts'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('isolates an actual hook-order crash, preserves controls and retries display without sending', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const prompt = vi.fn()
  function Broken({ fail }: { fail: boolean }) {
    useState(0)
    if (fail) return <p>broken</p>
    // oxlint-disable-next-line react/rules-of-hooks -- Deliberately reproduce the reported error to verify containment.
    useState(1)
    return <p>answer</p>
  }
  function View({ fail, id = 'one' }: { fail: boolean; id?: string }) {
    return <><nav>sidebar</nav><p>previous answer</p><RenderErrorBoundary key={id} scope="turn" sessionId={id} turnId="turn"><Broken fail={fail} /></RenderErrorBoundary><textarea defaultValue="draft" /><button onClick={prompt}>stop</button></>
  }
  await act(() => root.render(<View fail={false} />))
  await act(() => root.render(<View fail />))
  expect(container.textContent).toContain('这一轮内容暂时无法显示')
  expect(container.textContent).toContain('previous answer')
  expect(container.querySelector('nav')?.textContent).toBe('sidebar')
  expect(container.querySelector('textarea')?.value).toBe('draft')
  expect(log).toHaveBeenCalledWith('Conversation render failed', expect.objectContaining({ hookOrder: true, sessionId: 'one', turnId: 'turn', componentStack: expect.stringContaining('Broken') }))
  await act(() => root.render(<View fail={false} />))
  await act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === '重新加载显示')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: -1 })))
  expect(container.textContent).toContain('answer')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(prompt).not.toHaveBeenCalled()
  await act(() => root.render(<View fail />))
  await act(() => root.render(<View fail={false} id="two" />))
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('uses a recoverable route fallback instead of exposing the default stack page', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  function BrokenRoute(): never { throw new Error('Sensitive fixture message') }
  const router = createMemoryRouter([{ path: '*', element: <BrokenRoute />, errorElement: <RouteErrorPage /> }])
  try {
    await act(() => root.render(<RouterProvider router={router} />))
    expect(container.textContent).toContain('页面暂时无法显示')
    expect(container.querySelector('button')?.textContent).toBe('重新加载页面')
    expect(container.textContent).not.toContain('Sensitive fixture message')
    expect(container.textContent).not.toContain('Unexpected Application Error')
  } finally { router.dispose() }
})

it('keeps execution hooks stable through waiting, thinking, tool use, completion and re-expansion', async () => {
  const log = vi.spyOn(console, 'error')
  const item = { id: 'turn', prompt: 'question', startedAt: new Date().toISOString(), parts: [], events: [] } as unknown as TimelineItem
  const activities = [
    [],
    [{ id: 'thinking', kind: 'thinking' as const, text: 'reasoning' }],
    [{ id: 'tool', kind: 'tool' as const, label: 'read', status: 'running', duration: undefined, events: [] }],
  ]
  for (const list of activities) {
    await act(() => root.render(<TurnExecution item={item} isRunning presentation={{ activities: list, finalAnswer: [], hasExecution: list.length > 0 }} runStatus="running" />))
  }
  await act(() => root.render(<TurnExecution item={item} isRunning={false} presentation={{ activities: activities[1]!, finalAnswer: [], hasExecution: true }} runStatus="complete" />))
  await act(() => container.querySelector<HTMLButtonElement>('[data-execution-toggle]')!.click())
  expect(container.textContent).toContain('reasoning')
  expect(log).not.toHaveBeenCalled()
})

it('updates the mounted workspace across streaming phases and session switches without hook errors', async () => {
  const log = vi.spyOn(console, 'error')
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  const timestamp = new Date().toISOString()
  const sessions = [{ id: 'one', cwd: '/fixture', name: 'One' }, { id: 'two', cwd: '/fixture', name: 'Two' }]
  client.setQueryData(['sessions'], sessions)
  for (const session of sessions) {
    client.setQueryData(sessionHistoryQueryKey(session.id), { pages: [{ session, entries: [], revision: 'fixture', hasEarlier: false }], pageParams: [{}] })
    client.setQueryData(sessionTurnIndexQueryKey(session.id, 'fixture'), { entries: [], revision: 'fixture' })
  }
  useWorkspaceStore.setState({ runs: {}, drafts: { one: 'unsent' }, hiddenProjectCwds: {}, collapsedProjectKeys: {}, navigationOrder: { projectOrder: [], sessionOrderByProject: {} }, runtimeStates: { one: { lifecycle: 'idle', revision: 1 }, two: { lifecycle: 'idle', revision: 1 } }, watchStates: { one: 'ready', two: 'ready' }, runtimeDetails: { one: { model: { id: 'test', provider: 'fixture' } } as PiRuntimeState, two: { model: { id: 'test', provider: 'fixture' } } as PiRuntimeState } })
  const controller = { openSession: vi.fn(), releaseForeground: vi.fn(), getCommands: vi.fn(async () => []), start: vi.fn(), stop: vi.fn(async () => true) } as unknown as SessionRunController
  try {
    await act(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?session=one']}><WorkspacePage sessionRuns={controller} /></MemoryRouter></QueryClientProvider>))
    for (const status of ['submitted', 'awaiting_agent', 'running', 'awaiting_input', 'running', 'complete', 'aborted', 'error'] as const) {
      await act(() => useWorkspaceStore.getState().setRun('one', { status, turns: [{ id: 'turn', startedAt: timestamp, prompt: 'question', events: status === 'running' ? [{ sessionId: 'one', observedAt: timestamp, sequence: 1, event: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'reasoning' } } }] : [] }], systemEvents: [], pendingInputs: [] }))
      expect(container.querySelector('textarea')).not.toBeNull()
      expect(container.textContent).not.toContain('暂时无法显示')
    }
    expect(useWorkspaceStore.getState().drafts.one).toBe('unsent')
    expect(log).not.toHaveBeenCalled()
    log.mockImplementation(() => {})
    const crash = vi.spyOn(timeline, 'SessionTimeline').mockImplementation(() => { throw new Error('Synthetic timeline failure') })
    await act(() => useWorkspaceStore.getState().updateRun('one', { status: 'running' }))
    expect(container.textContent).toContain('对话内容暂时无法显示')
    expect(container.querySelector('textarea')?.value).toBe('unsent')
    expect(container.querySelector('[aria-label="停止生成"]')).not.toBeNull()
    expect(useWorkspaceStore.getState().runs.one?.status).toBe('running')
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="停止生成"]')!.click())
    expect(controller.stop).toHaveBeenCalledWith('one')
    crash.mockRestore()
    await act(() => useWorkspaceStore.getState().updateRun('one', { waitingMessage: 'restored' }))
    await act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === '重新加载显示')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: -1 })))
    expect(container.textContent).not.toContain('暂时无法显示')
    expect(controller.start).not.toHaveBeenCalled()
    await act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Two')!.click())
    expect(container.querySelector('h1')?.textContent).toBe('Two')
    await act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'One')!.click())
    expect(container.querySelector('textarea')?.value).toBe('unsent')
  } finally { client.clear() }
})
