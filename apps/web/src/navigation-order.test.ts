import { afterEach, expect, it, vi } from 'vitest'
import { applyNavigationOrder, emptyNavigationOrder, navigationOrdersEqual, reconcileNavigationOrder } from './navigation-order.js'
import { groupSessionsByProject } from './workspace.js'

const sessions = [
  { id: 'old', cwd: '/alpha', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' },
  { id: 'new', cwd: '/alpha', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' },
  { id: 'beta', cwd: '/beta', createdAt: '2026-10-05T00:00:00.000Z' },
]
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('keeps automatic order automatic and ignores activity, renaming and input order', () => {
  const source = groupSessionsByProject(sessions)
  const order = reconcileNavigationOrder(emptyNavigationOrder, source)
  expect(order.projectOrder).toEqual([])
  expect(order.sessionOrderByProject).toEqual({})
  expect(source.map((project) => project.key)).toEqual(['cwd:/beta', 'cwd:/alpha'])
  expect(source[1]?.sessions.map((session) => session.id)).toEqual(['new', 'old'])
  const changed = groupSessionsByProject([...sessions].reverse().map((session) => ({ ...session, name: 'renamed', updatedAt: '2026-10-20T00:00:00.000Z' })), order.projectCreatedAt)
  expect(changed.map((project) => project.key)).toEqual(source.map((project) => project.key))
  expect(changed[1]?.sessions.map((session) => session.id)).toEqual(['new', 'old'])
  expect(navigationOrdersEqual(order, reconcileNavigationOrder(order, changed))).toBe(true)
})

it('retains a project creation timestamp after its earliest session is deleted', () => {
  const order = reconcileNavigationOrder(emptyNavigationOrder, groupSessionsByProject(sessions))
  const remaining = groupSessionsByProject(sessions.filter((session) => session.id !== 'old'), order.projectCreatedAt)
  expect(remaining.map((project) => project.key)).toEqual(['cwd:/beta', 'cwd:/alpha'])
  expect(remaining[1]?.createdAt).toBe(sessions[0]?.createdAt)
})

it('prepends new projects and sessions while preserving independent manual orders', () => {
  const order = { projectOrder: ['cwd:/alpha', 'cwd:/beta'], sessionOrderByProject: { 'cwd:/alpha': ['old', 'new'] } }
  const source = groupSessionsByProject([...sessions,
    { id: 'latest', cwd: '/alpha', createdAt: '2026-10-13T00:00:00.000Z' },
    { id: 'gamma', cwd: '/gamma', createdAt: '2026-10-12T00:00:00.000Z' },
  ])
  const displayed = applyNavigationOrder(source, order)
  expect(displayed.map((project) => project.key)).toEqual(['cwd:/gamma', 'cwd:/alpha', 'cwd:/beta'])
  expect(displayed[1]?.sessions.map((session) => session.id)).toEqual(['latest', 'old', 'new'])
  expect(applyNavigationOrder(source, reconcileNavigationOrder(order, source))).toEqual(displayed)
  const sessionsOnly = applyNavigationOrder(source, { ...order, projectOrder: [] })
  expect(sessionsOnly.map((project) => project.key)).toEqual(source.map((project) => project.key))
})

it('uses IDs for deterministic ties and puts missing or invalid creation times last', () => {
  const source = groupSessionsByProject([
    { id: 'b', cwd: '/alpha', createdAt: sessions[0]!.createdAt },
    { id: 'missing', cwd: '/alpha' },
    { id: 'a', cwd: '/alpha', createdAt: sessions[0]!.createdAt },
    { id: 'invalid', cwd: '/alpha', createdAt: 'invalid' },
  ])
  expect(source[0]?.sessions.map((session) => session.id)).toEqual(['a', 'b', 'invalid', 'missing'])
})

it('restores project and session manual orders from local storage on a fresh store startup', async () => {
  const saved = new Map<string, string>()
  const localStorage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) }
  vi.stubGlobal('window', { localStorage })
  vi.resetModules()
  const first = (await import('./workspace-store.js')).useWorkspaceStore
  const order = reconcileNavigationOrder({ projectOrder: ['cwd:/alpha', 'cwd:/beta'], sessionOrderByProject: { 'cwd:/alpha': ['old', 'new'] } }, groupSessionsByProject(sessions))
  first.getState().setNavigationOrder(order)
  first.getState().setNavigationView('tree')
  first.getState().setSessionCollapsed('parent', false)
  expect(saved.has('pi-nest-navigation-order')).toBe(true)
  vi.resetModules()
  const restarted = (await import('./workspace-store.js')).useWorkspaceStore
  await restarted.persist.rehydrate()
  expect(restarted.getState().navigationOrder).toEqual(order)
  expect(restarted.getState().navigationView).toBe('tree')
  expect(restarted.getState().collapsedSessionIds).toEqual({ parent: false })
  const restored = applyNavigationOrder(groupSessionsByProject([...sessions].reverse(), restarted.getState().navigationOrder.projectCreatedAt), restarted.getState().navigationOrder)
  expect(restored.map((project) => project.key)).toEqual(['cwd:/alpha', 'cwd:/beta'])
  expect(restored[0]?.sessions.map((session) => session.id)).toEqual(['old', 'new'])
})

it('loads old preferences with list view and no session collapse overrides', async () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => JSON.stringify({ state: { navigationOrder: emptyNavigationOrder }, version: 0 }), setItem: vi.fn(), removeItem: vi.fn() } })
  vi.resetModules()
  const store = (await import('./workspace-store.js')).useWorkspaceStore
  await store.persist.rehydrate()
  expect(store.getState().navigationView).toBe('list')
  expect(store.getState().collapsedSessionIds).toEqual({})
})
