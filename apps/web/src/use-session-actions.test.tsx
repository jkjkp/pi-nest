import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionRunController } from './session-run-controller.js'
import { useSessionActions } from './use-session-actions.js'
import { branchSession, deleteSession, renameSession } from './workspace-api.js'
import { useWorkspaceStore } from './workspace-store.js'
import type { PiSessionGraph, PiSessionSummary } from '@pi-nest/contracts'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), branchSession: vi.fn(), deleteSession: vi.fn(), renameSession: vi.fn() }))
afterEach(() => vi.resetAllMocks())

function fixture(sessions: PiSessionSummary[] = [{ id: 'one', cwd: '/w' }, { id: 'two', cwd: '/w', parentSessionId: 'one' }], selected = 'one') {
  const client = new QueryClient()
  useWorkspaceStore.setState({ branchStorage: { available: true }, branchOperations: {}, runs: {}, sessionNotifications: {} })
  client.setQueryData(['sessions'], sessions)
  for (const id of ['one', 'two']) client.setQueryData(['session-graph', id], { sessions, branchStorage: { available: true } })
  const capture = vi.fn((_actions: ReturnType<typeof useSessionActions>) => null)
  const setSearchParams = vi.fn()
  function Probe() {
    return capture(useSessionActions({
      sessionRuns: { removeSessionNotification: vi.fn(), releaseForeground: vi.fn() } as unknown as SessionRunController,
      selectedSessionId: selected, selectedSessionIdRef: { current: selected }, modelOperation: { current: undefined }, sessions,
      projects: [{ key: 'fixture', name: 'Fixture', sessions }], refetchSessions: vi.fn(async () => {}), setSearchParams,
    }))
  }
  renderToStaticMarkup(<QueryClientProvider client={client}><Probe /></QueryClientProvider>)
  return { client, actions: capture.mock.calls[0][0], setSearchParams }
}

it('invalidates every cached tree after renaming through the shared action', async () => {
  const { client, actions } = fixture()
  try {
    await actions.handleRename('two', 'New name')
    expect(renameSession).toHaveBeenCalledExactlyOnceWith('two', 'New name')
    for (const id of ['one', 'two']) expect(client.getQueryState(['session-graph', id])?.isInvalidated).toBe(true)
  } finally { client.clear() }
})

it('invalidates trees and selects a remaining conversation after deleting the current session', async () => {
  const { client, actions, setSearchParams } = fixture()
  try {
    await actions.handleDelete('one')
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith('one')
    expect(client.getQueryData(['sessions'])).toEqual([{ id: 'two', cwd: '/w', parentSessionId: 'one' }])
    expect(setSearchParams).toHaveBeenCalledExactlyOnceWith({ session: 'two' })
    expect(client.getQueryState(['session-graph', 'one'])).toBeUndefined()
    expect(client.getQueryData(['session-graph', 'two'])).toMatchObject({ sessions: [{ id: 'two' }] })
    expect(client.getQueryState(['session-graph', 'two'])?.isInvalidated).toBe(true)
  } finally { client.clear() }
})

it('preserves the cached sessions and tree when deletion fails', async () => {
  vi.mocked(deleteSession).mockRejectedValueOnce(new Error('busy'))
  const { client, actions, setSearchParams } = fixture()
  try {
    await expect(actions.handleDelete('one')).rejects.toThrow('busy')
    expect(client.getQueryData(['sessions'])).toEqual([{ id: 'one', cwd: '/w' }, { id: 'two', cwd: '/w', parentSessionId: 'one' }])
    expect(client.getQueryState(['session-graph', 'one'])?.isInvalidated).toBe(false)
    expect(setSearchParams).not.toHaveBeenCalled()
  } finally { client.clear() }
})

it('seeds a cloned family before navigation without refetching the old graph or touching unrelated trees', async () => {
  const { client, actions } = fixture()
  const unrelated = { sessions: [{ id: 'unrelated', cwd: '/w' }], branchStorage: { available: true } }
  client.setQueryData(['session-graph', 'unrelated'], unrelated)
  const read = vi.fn(async () => client.getQueryData(['session-graph', 'one']))
  const observer = new QueryObserver(client, { queryKey: ['session-graph', 'one'], queryFn: read, staleTime: Infinity })
  const unsubscribe = observer.subscribe(() => {})
  const child = { id: 'clone', cwd: '/w', parentSessionId: 'one' }
  vi.mocked(branchSession).mockResolvedValueOnce({ session: child, draft: '' })
  try {
    await actions.createBranch({ kind: 'clone' })
    expect(client.getQueryData(['session-graph', 'clone'])).toMatchObject({ sessions: [{ id: 'one' }, { id: 'two' }, child] })
    expect(client.getQueryData(['session-graph', 'one'])).toMatchObject({ sessions: [{ id: 'one' }, { id: 'two' }, child] })
    expect(client.getQueryData(['session-graph', 'unrelated'])).toBe(unrelated)
    expect(client.getQueryState(['session-graph', 'unrelated'])?.isInvalidated).toBe(false)
    expect(read).not.toHaveBeenCalled()
  } finally { unsubscribe(); client.clear() }
})

it('selects the parent before unrelated conversations when deleting the current child', async () => {
  const { client, actions, setSearchParams } = fixture([{ id: 'unrelated', cwd: '/x' }, { id: 'one', cwd: '/w' }, { id: 'two', cwd: '/w', parentSessionId: 'one' }], 'two')
  try {
    await actions.handleDelete('two')
    expect(setSearchParams).toHaveBeenCalledExactlyOnceWith({ session: 'one' })
    expect(client.getQueryData(['session-graph', 'one'])).toMatchObject({ sessions: [{ id: 'one' }] })
  } finally { client.clear() }
})

it('prunes disconnected descendants after deleting a parent, retaining missing-parent siblings together', async () => {
  const sessions = [{ id: 'one', cwd: '/w' }, { id: 'two', cwd: '/w', parentSessionId: 'one' }, { id: 'leaf', cwd: '/w', parentSessionId: 'two' }, { id: 'sibling', cwd: '/w', parentSessionId: 'two' }]
  const { client, actions } = fixture(sessions)
  client.setQueryData(['session-graph', 'leaf'], { sessions, branchStorage: { available: true } })
  try {
    await actions.handleDelete('two')
    expect(client.getQueryData(['session-graph', 'one'])).toMatchObject({ sessions: [{ id: 'one' }] })
    expect(client.getQueryData(['session-graph', 'leaf'])).toMatchObject({ sessions: [{ id: 'leaf' }, { id: 'sibling' }] })
  } finally { client.clear() }
})

it.each(['delete', 'clone'] as const)('ignores an old first graph response arriving after a successful %s', async (operation) => {
  const { client, actions } = fixture()
  client.removeQueries({ queryKey: ['session-graph'] })
  const old = { sessions: [{ id: 'one', cwd: '/w' }, { id: 'two', cwd: '/w', parentSessionId: 'one' }], branchStorage: { available: true } }
  const child = { id: 'clone', cwd: '/w', parentSessionId: 'one' }
  const fresh = { ...old, sessions: operation === 'delete' ? [old.sessions[0]] : [...old.sessions, child] }
  let finish!: (graph: PiSessionGraph) => void
  const read = vi.fn(async ({ signal }: { signal: AbortSignal }): Promise<PiSessionGraph> => { void signal; return fresh })
    .mockImplementationOnce(({ signal }) => { void signal; return new Promise((resolve) => { finish = resolve }) })
  const observer = new QueryObserver(client, { queryKey: ['session-graph', 'one'], queryFn: read })
  const unsubscribe = observer.subscribe(() => {})
  vi.mocked(branchSession).mockResolvedValueOnce({ session: child, draft: '' })
  try {
    expect(client.getQueryData(['session-graph', 'one'])).toBeUndefined()
    if (operation === 'delete') await actions.handleDelete('two')
    else await actions.createBranch({ kind: 'clone' })
    finish(old)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.getQueryData(['session-graph', 'one'])).toEqual(fresh)
    expect(read.mock.calls[0][0].signal.aborted).toBe(true)
  } finally { unsubscribe(); client.clear() }
})
