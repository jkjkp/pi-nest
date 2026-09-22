import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from './app.js'
import type { PiRuntimeRegistry } from './pi-runtime-registry.js'
import { RuntimeSecurity } from './runtime-security.js'

const adapter = vi.hoisted(() => {
  class PiSessionHistorySourceChangedError extends Error {}
  return {
    PiSessionHistorySourceChangedError,
    deletePiSession: vi.fn(),
    listPiSessions: vi.fn(),
    readPiSessionHistory: vi.fn(),
    renamePiSession: vi.fn(),
  }
})
const { deletePiSession, listPiSessions, readPiSessionHistory, renamePiSession } = adapter

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
    beginMutation: vi.fn().mockResolvedValue(() => undefined),
    isPromptActive: vi.fn().mockReturnValue(false),
    startPrompt: vi.fn(),
  }
}

describe('Pi Nest API', () => {
  let runtime: ReturnType<typeof runtimeMock>

  beforeEach(() => {
    listPiSessions.mockReset(); deletePiSession.mockReset(); readPiSessionHistory.mockReset(); renamePiSession.mockReset()
    runtime = runtimeMock()
    listPiSessions.mockResolvedValue([nativeSession])
    readPiSessionHistory.mockReturnValue({ entries: [], hasEarlier: false })
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

})
