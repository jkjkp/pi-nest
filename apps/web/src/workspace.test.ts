import { describe, expect, it, vi } from 'vitest'

import {
  groupSessionsByProject,
  extensionStatusLine,
  extensionWidgetText,
  planModePolicy,
  filterProjectsByQuery,
  projectName,
  projectSessionGroupKey,
  runInspectorFields,
  runtimeStatusLabel,
  sessionDisplayName,
  sessionStatusLabel,
  shouldFollowLatest,
} from './workspace.js'
import { applyNavigationOrder, reconcileNavigationOrder } from './navigation-order.js'
import { useWorkspaceStore } from './workspace-store.js'

describe('workspace presentation helpers', () => {
  it('does not notify subscribers for an unchanged run status, but preserves real changes', () => {
    useWorkspaceStore.setState({ runs: {} })
    useWorkspaceStore.getState().updateRun('streaming', { status: 'running' })
    const before = useWorkspaceStore.getState()
    const notified = vi.fn()
    const unsubscribe = useWorkspaceStore.subscribe(notified)
    try {
      useWorkspaceStore.getState().updateRun('streaming', { status: 'running', waitingMessage: undefined })
      expect(useWorkspaceStore.getState()).toBe(before)
      expect(notified).not.toHaveBeenCalled()
      useWorkspaceStore.getState().updateRun('streaming', { status: 'aborted' })
      expect(notified).toHaveBeenCalledOnce()
      expect(useWorkspaceStore.getState().runs.streaming?.status).toBe('aborted')
    } finally { unsubscribe() }
  })
  it('keeps every session state readable without relying on color', () => {
    expect(sessionStatusLabel('running')).toBe('● 推理中')
    expect(sessionStatusLabel('submitted')).toBe('◌ 已提交，正在连接 Pi')
    expect(sessionStatusLabel('awaiting_agent')).toBe('◌ Pi 已接收，正在准备执行')
    expect(sessionStatusLabel('complete')).toBe('✓ 已完成')
    expect(sessionStatusLabel('error')).toBe('× 请求失败')
    expect(sessionStatusLabel('aborted')).toBe('— 已中止')
  })

  it('does not restore follow-latest during a timeline navigation away from the bottom', () => {
    expect(shouldFollowLatest(1_000, 905, 15, true)).toBe(false)
    expect(shouldFollowLatest(1_000, 905, 15, false)).toBe(true)
    expect(shouldFollowLatest(1_000, 700, 15, false)).toBe(false)
  })

  it('detects the bottom across short content, fractional offsets, and viewport resizing', () => {
    expect(shouldFollowLatest(300, 0, 500, false)).toBe(true)
    expect(shouldFollowLatest(1000, 419.5, 500, false)).toBe(false)
    expect(shouldFollowLatest(1000, 420, 500, false)).toBe(true)
    expect(shouldFollowLatest(1000, 420, 400, false)).toBe(false)
  })

  it('renders extension projection deterministically and strips terminal control sequences', () => {
    expect(extensionStatusLine({ zebra: '\u001B[31mZ\u001B[0m', alpha: ' A ' })).toBe('A Z')
    expect(extensionWidgetText({ zebra: ['Z'], alpha: ['\u001B[32mA\u001B[0m', 'B'] })).toBe('A\nB\n\nZ')
  })

  it('only exposes non-silent server lifecycle state when no local turn is active', () => {
    expect(runtimeStatusLabel({ lifecycle: 'idle', revision: 1 }, false)).toBeUndefined()
    expect(runtimeStatusLabel({ lifecycle: 'loading', revision: 2 }, false)).toBeUndefined()
    expect(runtimeStatusLabel({ lifecycle: 'active', revision: 2 }, true)).toBeUndefined()
    expect(runtimeStatusLabel({ lifecycle: 'active', revision: 2 }, false)).toBe('Pi 正在运行')
    expect(runtimeStatusLabel({ error: 'broken', lifecycle: 'failed', revision: 3 }, false)).toBe('Pi 运行时失败：broken')
  })

  it('derives compact navigation labels from safe session fields', () => {
    expect(projectName('/Users/example/AIWorking')).toBe('AIWorking')
  })

  it('groups by full cwd and sorts projects by earliest creation and sessions by creation', () => {
    const groups = groupSessionsByProject([
      { cwd: '/work/alpha', id: 'alpha-old', createdAt: '2026-09-20T00:00:00.000Z' },
      { cwd: '/elsewhere/alpha', id: 'other-alpha', createdAt: '2026-09-21T00:00:00.000Z' },
      { id: 'unknown' },
      { cwd: '/work/alpha', id: 'alpha-new', createdAt: '2026-09-22T00:00:00.000Z' },
      { cwd: '/work/beta', id: 'beta-invalid', createdAt: 'not-a-date' },
    ])

    expect(groups).toMatchObject([
      { key: 'cwd:/elsewhere/alpha', name: 'alpha', sessions: [{ id: 'other-alpha' }] },
      { key: 'cwd:/work/alpha', name: 'alpha', sessions: [{ id: 'alpha-new' }, { id: 'alpha-old' }] },
      { key: 'cwd:/work/beta', name: 'beta', sessions: [{ id: 'beta-invalid' }] },
      { key: 'cwd:unavailable', name: '工作目录不可用', sessions: [{ id: 'unknown' }] },
    ])
    expect(projectSessionGroupKey()).toBe('cwd:unavailable')
  })

  it('keeps collapse choices in UI-only state', () => {
    const projectKey = projectSessionGroupKey('/work/alpha')
    useWorkspaceStore.setState({ collapsedProjectKeys: {} })

    useWorkspaceStore.getState().setProjectCollapsed(projectKey, false)
    expect(useWorkspaceStore.getState().collapsedProjectKeys[projectKey]).toBe(false)

    useWorkspaceStore.getState().setProjectCollapsed(projectKey, true)
    expect(useWorkspaceStore.getState().collapsedProjectKeys[projectKey]).toBe(true)
  })

  it('hides projects only in persisted browser navigation preferences', () => {
    useWorkspaceStore.setState({ hiddenProjectCwds: {} })
    const store = useWorkspaceStore.getState()

    store.hideProject('/work/alpha')
    expect(useWorkspaceStore.getState().hiddenProjectCwds).toEqual({ '/work/alpha': true })
    store.restoreProject('/work/alpha')
    expect(useWorkspaceStore.getState().hiddenProjectCwds).toEqual({})
  })

  it('keeps initial desktop panel widths in UI-only state', () => {
    expect(useWorkspaceStore.getState()).toMatchObject({ inspectorWidth: 300, navigationWidth: 272 })
  })

  it('keeps extension UI isolated by session and replaces snapshots as whole projections', () => {
    useWorkspaceStore.setState({ extensionStatuses: {}, extensionWidgets: {}, runtimeStates: {} })
    const store = useWorkspaceStore.getState()
    store.replaceExtensionUi('one', { statuses: { agent: 'working' }, widgets: { todo: ['a'] } })
    store.setExtensionStatus('one', 'agent', undefined)
    store.setExtensionWidget('two', 'todo', ['b'])
    store.setRuntimeState('one', { lifecycle: 'active', revision: 2 })
    store.setRuntimeState('one', { lifecycle: 'idle', revision: 1 })
    expect(useWorkspaceStore.getState()).toMatchObject({
      extensionStatuses: { one: {} },
      extensionWidgets: { one: { todo: ['a'] }, two: { todo: ['b'] } },
      runtimeStates: { one: { lifecycle: 'active', revision: 2 } },
    })
  })

  it('filters by project metadata or session display name without changing the source groups', () => {
    const projects = groupSessionsByProject([
      { cwd: '/work/alpha', firstMessage: '修复导航', id: 'alpha' },
      { cwd: '/work/beta', firstMessage: '检查接口', id: 'beta' },
    ])

    expect(filterProjectsByQuery(projects, 'alpha')).toHaveLength(1)
    expect(filterProjectsByQuery(projects, '接口')[0]?.sessions).toMatchObject([{ id: 'beta' }])
    expect(projects).toHaveLength(2)
  })

  it('appends native events to only the matching session turn', () => {
    useWorkspaceStore.setState({
      runs: {
        first: { status: 'running', systemEvents: [], turns: [{ events: [], id: 'turn-1', prompt: 'known user input', startedAt: 'now' }] },
        second: { status: 'running', systemEvents: [], turns: [{ events: [], id: 'turn-2', startedAt: 'now' }] },
      },
    })

    useWorkspaceStore.getState().appendRunEvent('first', { event: { type: 'unknown_event' }, observedAt: 'now', sequence: 1, sessionId: 'first', turnId: 'turn-1' })

    expect(useWorkspaceStore.getState().runs).toMatchObject({
      first: { turns: [{ events: [{ event: { type: 'unknown_event' } }] }] },
      second: { turns: [{ events: [] }] },
    })
  })

  it('keeps unowned runtime events out of the timeline turn collection', () => {
    useWorkspaceStore.setState({
      runs: { first: { status: 'running', systemEvents: [], turns: [] } },
    })

    useWorkspaceStore.getState().appendRunEvent('first', { event: { type: 'tool_execution_start' }, observedAt: 'now', sequence: 1, sessionId: 'first', turnId: 'runtime-turn-1' })

    expect(useWorkspaceStore.getState().runs.first).toMatchObject({ systemEvents: [{ event: { type: 'tool_execution_start' } }], turns: [] })
  })

  it('freezes the most recent live turn at the browser completion timestamp', () => {
    useWorkspaceStore.setState({
      runs: { first: { status: 'running', systemEvents: [], turns: [{ events: [], id: 'turn-1', prompt: 'known user input', startedAt: '2026-09-22T00:00:00.000Z' }] } },
    })

    useWorkspaceStore.getState().completeLatestRunTurn('first', '2026-09-22T00:00:26.000Z')
    useWorkspaceStore.getState().completeLatestRunTurn('first', '2026-09-22T00:00:99.000Z')

    expect(useWorkspaceStore.getState().runs.first?.turns[0]?.completedAt).toBe('2026-09-22T00:00:26.000Z')
  })

  it('reconciles legacy manual order while prepending newly discovered items', () => {
    const source = [
      { key: 'cwd:/alpha', sessions: [{ id: 'new' }, { id: 'saved' }] },
      { key: 'cwd:/beta', sessions: [{ id: 'beta' }] },
    ]
    const order = reconcileNavigationOrder(
      {
        projectOrder: ['cwd:/beta', 'cwd:/gone'],
        sessionOrderByProject: { 'cwd:/alpha': ['saved', 'gone'] },
      },
      source,
    )

    expect(order).toEqual({
      projectOrder: ['cwd:/alpha', 'cwd:/beta'],
      sessionOrderByProject: { 'cwd:/alpha': ['new', 'saved'] },
      projectCreatedAt: {},
    })
    expect(applyNavigationOrder(source, order)).toEqual([
      { key: 'cwd:/alpha', sessions: [{ id: 'new' }, { id: 'saved' }] },
      { key: 'cwd:/beta', sessions: [{ id: 'beta' }] },
    ])
  })

  it('prefers an explicit name and falls back to the first user message', () => {
    expect(sessionDisplayName({ firstMessage: '首条提问', name: '自定义名称' })).toBe('自定义名称')
    expect(sessionDisplayName({ firstMessage: '首条提问' })).toBe('首条提问')
    expect(sessionDisplayName({})).toBe('未命名会话')
  })

  it('only exposes run details that this browser has observed', () => {
    expect(runInspectorFields(undefined)).toEqual({
      error: undefined,
      model: '当前不可用',
      stopReason: '当前不可用',
      eventCount: '当前不可用',
    })
    expect(
      runInspectorFields({
        error: 'safe failure',
        model: 'provider/model',
        status: 'aborted',
        stopReason: 'aborted',
        systemEvents: [{ event: { type: 'model_change' }, observedAt: 'now', sequence: 1, sessionId: 'first' }],
        turns: [{ events: [{ event: { type: 'message_update' }, observedAt: 'now', sequence: 2, sessionId: 'first', turnId: 'turn-1' }], id: 'turn-1', startedAt: 'now' }],
      }),
    ).toEqual({
      error: 'safe failure',
      model: 'provider/model',
      stopReason: 'aborted',
      eventCount: '2',
    })
  })
})

it('starts a new native user turn after completion instead of attaching implementation output to the plan', () => {
  const startedAt = '2026-10-14T03:13:36.000Z'
  const completedAt = '2026-10-14T03:15:15.000Z'
  useWorkspaceStore.setState({ runs: { test: { status: 'running', executionStartedAt: startedAt, systemEvents: [], turns: [{ id: 'planning', prompt: '/plan research', startedAt, completedAt, events: [] }] } } })
  const store = useWorkspaceStore.getState()
  store.markRunExecutionStarted('test', '2026-10-14T03:15:29.000Z')
  store.appendRunEvent('test', { sessionId: 'test', sequence: 1, turnId: 'implementation', observedAt: '2026-10-14T03:15:29.000Z', event: { type: 'turn_start' } })
  store.appendRunEvent('test', { sessionId: 'test', sequence: 2, turnId: 'implementation', observedAt: '2026-10-14T03:15:29.000Z', event: { type: 'message_start', message: { role: 'user', content: 'Implement the plan.' } } })
  store.appendRunEvent('test', { sessionId: 'test', sequence: 3, turnId: 'implementation', observedAt: '2026-10-14T03:16:52.000Z', event: { type: 'message_end', message: { role: 'assistant', content: 'Final report' } } })
  const turns = useWorkspaceStore.getState().runs.test!.turns
  expect(turns).toHaveLength(2)
  expect(turns[0]).toMatchObject({ startedAt, completedAt, events: [] })
  expect(turns[1]).toMatchObject({ prompt: 'Implement the plan.' })
  expect(turns[1]!.events).toHaveLength(2)
})

it('hides only the Plan widget and moves its tool policy to status details', () => {
  const widgets = {
    'plan-mode-plan': ['Plan mode: planning', '\u001b[36mPlan policy allows: bash, read. Model-visible tools stay unchanged.\u001b[0m', 'Finish with plan_mode_complete when decision-ready.'],
    todos: ['Important extension progress'],
  }
  expect(extensionWidgetText(widgets)).toBe('Important extension progress')
  expect(planModePolicy(widgets)).toBe('Plan policy allows: bash, read.')
  expect(extensionStatusLine({ 'plan-mode': 'plan active ●', ponytail: 'ponytail: FULL' })).toBe('ponytail: FULL')
  expect(extensionWidgetText({ 'plan-mode-plan': widgets['plan-mode-plan'] })).toBe('')
  expect(planModePolicy({ 'plan-mode-plan': ['Proposed plan ready'] })).toBeUndefined()
})
