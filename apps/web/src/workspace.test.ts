import { describe, expect, it } from 'vitest'

import {
  groupSessionsByProject,
  projectName,
  projectIsCollapsed,
  projectSessionGroupKey,
  runInspectorFields,
  sessionDisplayName,
  sessionStatusLabel,
  shortSessionId,
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

  it('derives compact navigation labels from safe session fields', () => {
    expect(projectName('/Users/example/AIWorking')).toBe('AIWorking')
    expect(shortSessionId('01a0bf7e-efc7-75e2-a447-0f78a9a7530a')).toBe('01a0bf7e')
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

  it('keeps newly discovered projects collapsed until the user opens them', () => {
    expect(projectIsCollapsed({}, 'cwd:/alpha')).toBe(true)
    expect(projectIsCollapsed({ 'cwd:/alpha': false }, 'cwd:/alpha')).toBe(false)
  })

  it('keeps initial desktop panel widths in UI-only state', () => {
    expect(useWorkspaceStore.getState()).toMatchObject({ inspectorWidth: 288, navigationWidth: 272 })
  })

  it('appends stream deltas to only the target session', () => {
    useWorkspaceStore.setState({
      runs: {
        first: { responseText: 'A', status: 'running', textDeltaCount: 1 },
        second: { responseText: 'B', status: 'running', textDeltaCount: 1 },
      },
    })

    useWorkspaceStore.getState().appendRunDelta('first', 'C')

    expect(useWorkspaceStore.getState().runs).toMatchObject({
      first: { responseText: 'AC', textDeltaCount: 2 },
      second: { responseText: 'B', textDeltaCount: 1 },
    })
  })

  it('keeps project collapse state in memory', () => {
    const projectKey = projectSessionGroupKey('/work/alpha')
    useWorkspaceStore.setState({ collapsedProjectKeys: {} })

    useWorkspaceStore.getState().toggleProjectCollapsed(projectKey)
    expect(useWorkspaceStore.getState().collapsedProjectKeys[projectKey]).toBe(false)

    useWorkspaceStore.getState().toggleProjectCollapsed(projectKey)
    expect(useWorkspaceStore.getState().collapsedProjectKeys[projectKey]).toBe(true)
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
      textDeltaCount: '当前不可用',
    })
    expect(
      runInspectorFields({
        error: 'safe failure',
        model: 'provider/model',
        responseText: 'text',
        status: 'aborted',
        stopReason: 'aborted',
        textDeltaCount: 3,
      }),
    ).toEqual({
      error: 'safe failure',
      model: 'provider/model',
      stopReason: 'aborted',
      textDeltaCount: '3',
    })
  })
})
