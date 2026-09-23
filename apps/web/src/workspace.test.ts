import { describe, expect, it } from 'vitest'

import {
  groupSessionsByProject,
  extensionStatusLine,
  extensionWidgetText,
  filterProjectsByQuery,
  projectName,
  projectSessionGroupKey,
  runInspectorFields,
  runtimeStatusLabel,
  sessionDisplayName,
  sessionStatusLabel,
} from './workspace.js'
import { applyNavigationOrder, reconcileNavigationOrder } from './navigation-order.js'
import { useWorkspaceStore } from './workspace-store.js'

describe('workspace presentation helpers', () => {
  it('keeps every session state readable without relying on color', () => {
    expect(sessionStatusLabel('running')).toBe('● 推理中')
    expect(sessionStatusLabel('complete')).toBe('✓ 已完成')
    expect(sessionStatusLabel('error')).toBe('× 请求失败')
    expect(sessionStatusLabel('aborted')).toBe('— 已中止')
  })

  it('renders extension projection deterministically and strips terminal control sequences', () => {
    expect(extensionStatusLine({ zebra: '\u001B[31mZ\u001B[0m', alpha: ' A ' })).toBe('A Z')
    expect(extensionWidgetText({ zebra: ['Z'], alpha: ['\u001B[32mA\u001B[0m', 'B'] })).toBe('A\nB\n\nZ')
  })

  it('only exposes non-silent server lifecycle state when no local turn is active', () => {
    expect(runtimeStatusLabel({ lifecycle: 'idle', revision: 1 }, false)).toBeUndefined()
    expect(runtimeStatusLabel({ lifecycle: 'active', revision: 2 }, true)).toBeUndefined()
    expect(runtimeStatusLabel({ lifecycle: 'active', revision: 2 }, false)).toBe('Pi 正在运行')
    expect(runtimeStatusLabel({ error: 'broken', lifecycle: 'failed', revision: 3 }, false)).toBe('Pi 运行时失败：broken')
  })

  it('derives compact navigation labels from safe session fields', () => {
    expect(projectName('/Users/example/AIWorking')).toBe('AIWorking')
  })

  it('groups sessions by full cwd without merging same-named projects', () => {
    const groups = groupSessionsByProject([
      { cwd: '/work/alpha', id: 'alpha-old', updatedAt: '2026-09-20T00:00:00.000Z' },
      { cwd: '/elsewhere/alpha', id: 'other-alpha', updatedAt: '2026-09-21T00:00:00.000Z' },
      { id: 'unknown' },
      { cwd: '/work/alpha', id: 'alpha-new', updatedAt: '2026-09-22T00:00:00.000Z' },
      { cwd: '/work/beta', id: 'beta-invalid', updatedAt: 'not-a-date' },
    ])

    expect(groups).toMatchObject([
      { key: 'cwd:/work/alpha', name: 'alpha', sessions: [{ id: 'alpha-new' }, { id: 'alpha-old' }] },
      { key: 'cwd:/elsewhere/alpha', name: 'alpha', sessions: [{ id: 'other-alpha' }] },
      { key: 'cwd:unavailable', name: '工作目录不可用', sessions: [{ id: 'unknown' }] },
      { key: 'cwd:/work/beta', name: 'beta', sessions: [{ id: 'beta-invalid' }] },
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
        first: { status: 'running', systemEvents: [], turns: [{ events: [], id: 'turn-1', startedAt: 'now' }] },
        second: { status: 'running', systemEvents: [], turns: [{ events: [], id: 'turn-2', startedAt: 'now' }] },
      },
    })

    useWorkspaceStore.getState().appendRunEvent('first', { event: { type: 'unknown_event' }, observedAt: 'now', sequence: 1, sessionId: 'first', turnId: 'turn-1' })

    expect(useWorkspaceStore.getState().runs).toMatchObject({
      first: { turns: [{ events: [{ event: { type: 'unknown_event' } }] }] },
      second: { turns: [{ events: [] }] },
    })
  })

  it('reconciles persisted navigation order while appending newly discovered sessions', () => {
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
      projectOrder: ['cwd:/beta', 'cwd:/alpha'],
      sessionOrderByProject: { 'cwd:/alpha': ['saved', 'new'], 'cwd:/beta': ['beta'] },
    })
    expect(applyNavigationOrder(source, order)).toEqual([
      { key: 'cwd:/beta', sessions: [{ id: 'beta' }] },
      { key: 'cwd:/alpha', sessions: [{ id: 'saved' }, { id: 'new' }] },
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
