import { describe, expect, it } from 'vitest'

import { projectName, sessionStatusLabel, shortSessionId } from './workspace.js'
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
})
