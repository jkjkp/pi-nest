import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from './app.js'
import type { PiRuntimeRegistry } from './pi-runtime-registry.js'
import { RuntimeSecurity } from './runtime-security.js'

const adapter = vi.hoisted(() => {
  class PiSessionHistorySourceChangedError extends Error {}
  return {
    PiSessionHistorySourceChangedError,
    createPiSession: vi.fn(),
    deletePiSession: vi.fn(),
    listPiSessions: vi.fn(),
    readPiSessionHistory: vi.fn(),
    renamePiSession: vi.fn(),
    revealPiWorkspace: vi.fn(),
  }
})
const { createPiSession, deletePiSession, listPiSessions, readPiSessionHistory, renamePiSession, revealPiWorkspace } = adapter

vi.mock('@pi-nest/pi-adapter', () => ({
  ...adapter,
}))

const nativeSession = {
  cwd: '/working', firstMessage: 'Original question', id: 'session-1', name: 'Existing session',
  sessionFile: '/pi/session.jsonl', updatedAt: '2026-09-21T00:00:00.000Z',
}
function runtimeMock() {
  return {
    abort: vi.fn().mockResolvedValue(false),
    beginPrompt: vi.fn(),
    beginMutation: vi.fn().mockResolvedValue(() => undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    isPromptActive: vi.fn().mockReturnValue(false),
    startPrompt: vi.fn(),
  }
}

describe('Pi Nest API', () => {
  let runtime: ReturnType<typeof runtimeMock>

  beforeEach(() => {
    createPiSession.mockReset(); deletePiSession.mockReset(); listPiSessions.mockReset(); readPiSessionHistory.mockReset(); renamePiSession.mockReset(); revealPiWorkspace.mockReset()
    runtime = runtimeMock()
    listPiSessions.mockResolvedValue([nativeSession])
    readPiSessionHistory.mockReturnValue({ entries: [] })
    createPiSession.mockReturnValue({ cwd: '/working', id: 'created-session', sessionFile: '/pi/created.jsonl' })
    deletePiSession.mockResolvedValue({ method: 'trash' })
    revealPiWorkspace.mockResolvedValue(undefined)
  })

  function app() { return createApp(runtime as unknown as PiRuntimeRegistry) }

  it('reports readiness and lists safe native session summaries', async () => {
    const health = await app().request('/api/health')
    await expect(health.json()).resolves.toEqual({ status: 'ok' })
    const response = await app().request('/api/sessions')
    await expect(response.json()).resolves.toEqual({
      sessions: [{ cwd: '/working', firstMessage: 'Original question', id: 'session-1', name: 'Existing session', updatedAt: nativeSession.updatedAt }],
    })
  })

  it('issues a runtime bootstrap token only to the configured origin', async () => {
    const securedApp = createApp(runtime as unknown as PiRuntimeRegistry, new RuntimeSecurity('http://localhost:5173'))
    const rejected = await securedApp.request('/api/runtime/bootstrap', { method: 'POST' })
    expect(rejected.status).toBe(403)
    const accepted = await securedApp.request('/api/runtime/bootstrap', { method: 'POST', headers: { origin: 'http://localhost:5173' } })
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toMatchObject({ runtimeId: expect.any(String), websocketPath: '/api/runtime', token: expect.any(String) })
  })

  it('reads safe history and rejects it while the runtime owns the session', async () => {
    const response = await app().request('/api/sessions/session-1/history')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ entries: [], session: { cwd: '/working', id: 'session-1', updatedAt: nativeSession.updatedAt } })
    expect(readPiSessionHistory).toHaveBeenCalledWith({ expectedCwd: '/working', expectedSessionId: 'session-1', sessionFile: '/pi/session.jsonl' })
    runtime.isPromptActive.mockReturnValue(true)
    expect((await app().request('/api/sessions/session-1/history')).status).toBe(409)
  })

  it('keeps native session mutations mutually exclusive through the runtime registry', async () => {
    const finish = vi.fn()
    runtime.beginMutation.mockReturnValueOnce(Promise.resolve(finish))
    const renamed = await app().request('/api/sessions/session-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(renamed.status).toBe(200)
    expect(renamePiSession).toHaveBeenCalledWith({ expectedCwd: '/working', expectedSessionId: 'session-1', name: 'Renamed', sessionFile: '/pi/session.jsonl' })
    expect(finish).toHaveBeenCalledOnce()
    runtime.beginMutation.mockReturnValueOnce(undefined)
    expect((await app().request('/api/sessions/session-1', { method: 'DELETE' })).status).toBe(409)
    expect(deletePiSession).not.toHaveBeenCalled()
  })

  it('creates a native session only when the first prompt is admitted, then exposes a safe summary', async () => {
    runtime.beginPrompt.mockReturnValue({ accepted: Promise.resolve(), settled: new Promise(() => undefined) })

    const response = await app().request('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/working', prompt: ' First prompt ' }),
    })

    expect(response.status).toBe(201)
    expect(createPiSession).toHaveBeenCalledWith('/working')
    expect(runtime.beginPrompt).toHaveBeenCalledWith({ cwd: '/working', id: 'created-session', sessionFile: '/pi/created.jsonl' }, 'First prompt')
    await expect(response.json()).resolves.toMatchObject({ session: { cwd: '/working', firstMessage: 'First prompt', id: 'created-session' } })
  })

  it('rolls back an unadmitted first prompt without exposing an empty session', async () => {
    runtime.beginPrompt.mockReturnValue({ accepted: Promise.reject(new Error('startup failed')), settled: Promise.resolve({ model: undefined, stopReason: undefined }) })

    const response = await app().request('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/working', prompt: 'First prompt' }),
    })
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: 'SESSION_INITIALIZATION_FAILED', error: 'Failed to initialize Pi session' })

    expect(runtime.deleteSession).toHaveBeenCalledWith('created-session')
    expect(deletePiSession).toHaveBeenCalledWith({ expectedCwd: '/working', expectedSessionId: 'created-session', sessionFile: '/pi/created.jsonl' })
  })

  it('does not start a prompt when native session bootstrap fails', async () => {
    createPiSession.mockImplementation(() => { throw new Error('/private/path should remain server-only') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await app().request('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/working', prompt: 'First prompt' }),
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: 'SESSION_INITIALIZATION_FAILED', error: 'Failed to initialize Pi session' })
    expect(runtime.beginPrompt).not.toHaveBeenCalled()
    expect(runtime.deleteSession).not.toHaveBeenCalled()
    expect(deletePiSession).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('Failed to initialize Pi session', { cause: expect.any(Error) })
    log.mockRestore()
  })

  it('reveals only a cwd that still belongs to a discovered Pi project', async () => {
    expect((await app().request('/api/projects/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/working' }),
    })).status).toBe(204)
    expect(revealPiWorkspace).toHaveBeenCalledWith('/working')

    expect((await app().request('/api/projects/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/unknown' }),
    })).status).toBe(404)
    expect(revealPiWorkspace).toHaveBeenCalledTimes(1)
  })

})
