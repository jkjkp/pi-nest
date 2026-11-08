import { createStore } from 'zustand/vanilla'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceState } from './workspace-store.js'

afterEach(() => vi.unstubAllGlobals())

it('creates independent mutable state and real actions without persistence', () => {
  const first = createStore(createWorkspaceState)
  const second = createStore(createWorkspaceState)
  for (const [key, value] of Object.entries(first.getState())) {
    if (typeof value === 'object' && value !== null) expect(value).not.toBe(second.getState()[key as keyof ReturnType<typeof createWorkspaceState>])
  }
  first.getState().navigationOrder.projectOrder.push('first')
  first.getState().setDraft('shared', 'first draft')
  first.getState().appendPendingInput('shared', { id: 'input', message: 'first input', mode: 'follow_up', submittedAt: 'now' })
  expect(second.getState().navigationOrder.projectOrder).toEqual([])
  expect(second.getState().drafts).toEqual({})
  expect(second.getState().runs).toEqual({})
  expect(first).not.toHaveProperty('persist')
})

it('keeps notification persistence and excludes live runtime state from a fresh production store', async () => {
  const saved = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  } })
  vi.resetModules()
  const first = (await import('./workspace-store.js')).useWorkspaceStore
  first.getState().trackPendingRun('shared', 'run')
  first.getState().finishNotification('shared', 'run', true, true)
  first.getState().setRuntimeState('shared', { lifecycle: 'active', revision: 2 })
  first.getState().setDraft('shared', 'temporary')
  first.getState().setGraphSplitRatio(0.6)
  first.getState().setBodyFontSize(20)
  const persisted = JSON.parse(saved.get('pi-nest-navigation-order')!)
  expect(persisted.version).toBe(0)
  expect(persisted.state.sessionNotifications.shared).toEqual({ completedRunId: 'run' })
  expect(persisted.state.graphSplitRatio).toBe(0.6)
  expect(persisted.state.bodyFontSize).toBe(20)
  expect(persisted.state).not.toHaveProperty('runtimeStates')
  expect(persisted.state).not.toHaveProperty('drafts')
  vi.resetModules()
  const restarted = (await import('./workspace-store.js')).useWorkspaceStore
  await restarted.persist.rehydrate()
  expect(restarted.getState().sessionNotifications.shared).toEqual({ completedRunId: 'run' })
  expect(restarted.getState().runtimeStates).toEqual({})
  expect(restarted.getState().drafts).toEqual({})
  expect(restarted.getState().graphSplitRatio).toBe(0.6)
  expect(restarted.getState().bodyFontSize).toBe(20)
  saved.set('pi-nest-navigation-order', JSON.stringify({ state: { graphSplitRatio: 'invalid' }, version: 0 }))
  vi.resetModules()
  const invalid = (await import('./workspace-store.js')).useWorkspaceStore
  await invalid.persist.rehydrate()
  expect(invalid.getState().graphSplitRatio).toBe(0.45)
  expect(invalid.getState().bodyFontSize).toBe(15)
  for (const bodyFontSize of [null, '20', 17, 200, {}, []]) {
    saved.set('pi-nest-navigation-order', JSON.stringify({ state: { bodyFontSize }, version: 0 }))
    await invalid.persist.rehydrate()
    expect(invalid.getState().bodyFontSize).toBe(15)
  }
})

it('accepts supported body font sizes and resets invalid values to the default', () => {
  const store = createStore(createWorkspaceState)
  expect(store.getState().bodyFontSize).toBe(15)
  for (const size of [14, 15, 16, 18, 20]) {
    store.getState().setBodyFontSize(size)
    expect(store.getState().bodyFontSize).toBe(size)
  }
  for (const size of [0, 17, 21, NaN, Infinity]) {
    store.getState().setBodyFontSize(size)
    expect(store.getState().bodyFontSize).toBe(15)
  }
})
