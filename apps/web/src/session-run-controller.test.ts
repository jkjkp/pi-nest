import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSessionRunController } from './session-run-controller.js'
import type { ServerSentEvent } from './read-sse.js'
import { useWorkspaceStore } from './workspace-store.js'

type Stream = {
  complete: () => void
  emit: (event: string, data: object) => Promise<void>
}

async function waitFor(assertion: () => void) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion()
      return
    } catch {
      await Promise.resolve()
    }
  }
  assertion()
}

function createStreamingDependencies() {
  const streams = new Map<string, Stream>()
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const sessionId = String(input).split('/').at(-2)!
    return new Response(null, { headers: { 'x-session-id': sessionId } })
  })
  const readSseFn = vi.fn(async (response: Response, onEvent: (event: ServerSentEvent) => Promise<void> | void) => {
    const sessionId = response.headers.get('x-session-id')!
    let resolve!: () => void
    const done = new Promise<void>((doneResolve) => {
      resolve = doneResolve
    })
    streams.set(sessionId, {
      complete: resolve,
      emit: async (event, data) => {
        await onEvent({ data: JSON.stringify(data), event })
      },
    })
    await done
  })

  return { fetchFn, readSseFn, streams }
}

describe('session run controller', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ runs: {} })
  })

  it('keeps concurrent session streams isolated and rejects a local duplicate', async () => {
    const { fetchFn, readSseFn, streams } = createStreamingDependencies()
    const invalidateHistory = vi.fn()
    const controller = createSessionRunController({ fetchFn, invalidateHistory, readSseFn })

    expect(controller.start({ prompt: 'A', sessionId: 'session-a' })).toBe(true)
    expect(controller.start({ prompt: 'B', sessionId: 'session-b' })).toBe(true)
    expect(controller.start({ prompt: 'again', sessionId: 'session-a' })).toBe(false)
    await waitFor(() => expect(streams.size).toBe(2))

    await streams.get('session-a')!.emit('text_delta', { delta: 'A1' })
    await streams.get('session-b')!.emit('text_delta', { delta: 'B1' })
    await streams.get('session-a')!.emit('text_delta', { delta: 'A2' })

    expect(useWorkspaceStore.getState().runs).toMatchObject({
      'session-a': { responseText: 'A1A2', status: 'running', textDeltaCount: 2 },
      'session-b': { responseText: 'B1', status: 'running', textDeltaCount: 1 },
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)

    await streams.get('session-a')!.emit('complete', { model: { id: 'model', provider: 'provider' }, stopReason: 'stop' })
    streams.get('session-a')!.complete()
    await waitFor(() => expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('complete'))
    expect(useWorkspaceStore.getState().runs['session-b']?.status).toBe('running')
    await waitFor(() => expect(invalidateHistory).toHaveBeenCalledWith('session-a'))

    await streams.get('session-b')!.emit('complete', { stopReason: 'stop' })
    streams.get('session-b')!.complete()
    await waitFor(() => expect(useWorkspaceStore.getState().runs['session-b']?.status).toBe('complete'))
  })

  it('stops only the requested session and waits for its aborted SSE completion', async () => {
    const { fetchFn, readSseFn, streams } = createStreamingDependencies()
    fetchFn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).endsWith('/abort')) return new Response(null, { status: 202 })
      const sessionId = String(input).split('/').at(-2)!
      return new Response(null, { headers: { 'x-session-id': sessionId } })
    })
    const controller = createSessionRunController({ fetchFn, invalidateHistory: vi.fn(), readSseFn })

    controller.start({ prompt: 'A', sessionId: 'session-a' })
    controller.start({ prompt: 'B', sessionId: 'session-b' })
    await waitFor(() => expect(streams.size).toBe(2))

    await expect(controller.stop('session-a')).resolves.toBe(true)
    expect(useWorkspaceStore.getState().runs).toMatchObject({
      'session-a': { status: 'aborting' },
      'session-b': { status: 'running' },
    })
    expect(fetchFn).toHaveBeenLastCalledWith('/api/sessions/session-a/abort', { method: 'POST' })

    await streams.get('session-a')!.emit('complete', { stopReason: 'aborted' })
    streams.get('session-a')!.complete()
    await waitFor(() => expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('aborted'))
    expect(useWorkspaceStore.getState().runs['session-b']?.status).toBe('running')

    await streams.get('session-b')!.emit('complete', { stopReason: 'stop' })
    streams.get('session-b')!.complete()
    await waitFor(() => expect(useWorkspaceStore.getState().runs['session-b']?.status).toBe('complete'))
  })

  it('records safe HTTP failures and permits a later retry after cleanup', async () => {
    const fetchFn = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Pi session is already running' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Pi session is already running' }), { status: 409 }))
    const controller = createSessionRunController({ fetchFn, invalidateHistory: vi.fn() })

    expect(controller.start({ prompt: 'A', sessionId: 'session-a' })).toBe(true)
    await waitFor(() => expect(useWorkspaceStore.getState().runs['session-a']?.status).toBe('error'))
    expect(useWorkspaceStore.getState().runs['session-a']?.error).toBe('Pi session is already running')
    expect(controller.start({ prompt: 'retry', sessionId: 'session-a' })).toBe(true)
  })
})
