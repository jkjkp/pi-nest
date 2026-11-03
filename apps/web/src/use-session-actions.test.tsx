import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionRunController } from './session-run-controller.js'
import { useSessionActions } from './use-session-actions.js'
import { deleteSession, renameSession } from './workspace-api.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), deleteSession: vi.fn(), renameSession: vi.fn() }))
afterEach(() => vi.resetAllMocks())

function fixture() {
  const client = new QueryClient()
  const sessions = [{ id: 'one' }, { id: 'two' }]
  client.setQueryData(['sessions'], sessions)
  for (const id of ['one', 'two']) client.setQueryData(['session-graph', id], { sessions })
  const capture = vi.fn((_actions: ReturnType<typeof useSessionActions>) => null)
  const setSearchParams = vi.fn()
  function Probe() {
    return capture(useSessionActions({
      sessionRuns: { removeSessionNotification: vi.fn(), releaseForeground: vi.fn() } as unknown as SessionRunController,
      selectedSessionId: 'one', selectedSessionIdRef: { current: 'one' }, modelOperation: { current: undefined }, sessions,
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
    expect(client.getQueryData(['sessions'])).toEqual([{ id: 'two' }])
    expect(setSearchParams).toHaveBeenCalledExactlyOnceWith({ session: 'two' })
    for (const id of ['one', 'two']) expect(client.getQueryState(['session-graph', id])?.isInvalidated).toBe(true)
  } finally { client.clear() }
})

it('preserves the cached sessions and tree when deletion fails', async () => {
  vi.mocked(deleteSession).mockRejectedValueOnce(new Error('busy'))
  const { client, actions, setSearchParams } = fixture()
  try {
    await expect(actions.handleDelete('one')).rejects.toThrow('busy')
    expect(client.getQueryData(['sessions'])).toEqual([{ id: 'one' }, { id: 'two' }])
    expect(client.getQueryState(['session-graph', 'one'])?.isInvalidated).toBe(false)
    expect(setSearchParams).not.toHaveBeenCalled()
  } finally { client.clear() }
})
