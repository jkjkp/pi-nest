import { AttachmentStore } from './attachment-store.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { preparePiImage } from '@pi-nest/pi-adapter'
import { createApp } from './app.js'
import { createSessionIndexFixture } from './test-fixtures/session-index.js'
import { PiRuntimeRegistry } from './pi-runtime-registry.js'
import type { PiRuntimeHost } from './pi-runtime-host.js'
import { RuntimeSecurity } from './runtime-security.js'

const adapter = vi.hoisted(() => {
  class PiSessionBranchTargetError extends Error {}
  class PiSessionHistoryCursorError extends Error {}
  class PiSessionHistoryRevisionError extends Error { constructor() { super(); this.name = 'PiSessionHistoryRevisionError' } }
  class PiSessionHistorySourceChangedError extends Error {}
  return {
    PiSessionBranchTargetError,
    branchPiSession: vi.fn(),
    readPiSessionForkSource: vi.fn(),
    PiSessionHistoryCursorError,
    PiSessionHistoryRevisionError,
    PiSessionHistorySourceChangedError,
    capturePiSessionHistory: vi.fn(),
    createPiSession: vi.fn(),
    deletePiSession: vi.fn(),
    preparePiImage: vi.fn(),
    readPiSessionHistory: vi.fn(),
    readPiSessionTurnIndex: vi.fn(),
    renamePiSession: vi.fn(),
    revealPiWorkspace: vi.fn(),
  }
})
const { createPiSession, deletePiSession, readPiSessionHistory, readPiSessionTurnIndex, renamePiSession, revealPiWorkspace } = adapter

vi.mock('@pi-nest/pi-adapter', async (original) => {
  const actual = await original<typeof import('@pi-nest/pi-adapter')>()
  adapter.capturePiSessionHistory.mockImplementation(() => ({ entries: [], revision: 'a'.repeat(64), bytes: 1 }))
  adapter.preparePiImage.mockImplementation(actual.preparePiImage)
  return { ...actual, ...adapter }
})

const nativeSession = {
  createdAt: '2026-09-19T00:00:00.000Z', cwd: '/working', firstMessage: 'Original question', id: 'session-1', name: 'Existing session',
  sessionFile: '/pi/session.jsonl', updatedAt: '2026-09-21T00:00:00.000Z',
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const imageStream = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(png, 'base64')); c.close() } })
function nativeHost() {
  return {
    beginPrompt: vi.fn(() => ({ accepted: Promise.resolve(), settled: Promise.resolve({ model: undefined, stopReason: 'stop' }) })),
    close: vi.fn().mockResolvedValue(undefined),
    command: vi.fn().mockResolvedValue({}),
    currentModel: undefined,
    currentThinkingLevel: undefined,
    onEvent: vi.fn(() => () => undefined),
    onFailure: vi.fn(() => () => undefined),
    start: vi.fn().mockResolvedValue({}),
  }
}
function runtimeMock() {
  return {
    attachments: new AttachmentStore(),
    history: {
      history: vi.fn((session, options) => adapter.readPiSessionHistory({ expectedCwd: session.cwd, expectedSessionId: session.id, sessionFile: session.sessionFile, ...options })),
      index: vi.fn((session, revision) => adapter.readPiSessionTurnIndex({ expectedCwd: session.cwd, expectedSessionId: session.id, sessionFile: session.sessionFile, ...(revision ? { revision } : {}) })),
    },
    abort: vi.fn().mockResolvedValue(false),
    beginPrompt: vi.fn(),
    beginMutation: vi.fn().mockResolvedValue(() => undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    isPromptStreaming: vi.fn().mockReturnValue(false),
    startPrompt: vi.fn(),
  }
}

let sessionIndex: ReturnType<typeof createSessionIndexFixture>
beforeEach(() => { sessionIndex = createSessionIndexFixture([nativeSession]) })

describe('Pi Nest API', () => {
  let runtime: ReturnType<typeof runtimeMock>

  beforeEach(() => {
    createPiSession.mockReset(); deletePiSession.mockReset(); readPiSessionHistory.mockReset(); readPiSessionTurnIndex.mockReset(); renamePiSession.mockReset(); revealPiWorkspace.mockReset()
    runtime = runtimeMock()
    readPiSessionHistory.mockReturnValue({ entries: [], hasEarlier: false, revision: 'a'.repeat(64) })
    readPiSessionTurnIndex.mockReturnValue({ entries: [], revision: 'a'.repeat(64) })
    createPiSession.mockReturnValue({ createdAt: '2026-10-13T00:00:00.000Z', cwd: '/working', id: 'created-session', sessionFile: '/pi/created.jsonl' })
    deletePiSession.mockResolvedValue({ method: 'trash' })
    revealPiWorkspace.mockResolvedValue(undefined)
  })

  function app() { return createApp(runtime as unknown as PiRuntimeRegistry, undefined, undefined, sessionIndex.index) }

  it('reports readiness and lists safe native session summaries', async () => {
    const health = await app().request('/api/health')
    await expect(health.json()).resolves.toEqual({ status: 'ok' })
    const response = await createApp(runtimeMock() as unknown as PiRuntimeRegistry, undefined, undefined, sessionIndex.index).request('/api/sessions')
    await expect(response.json()).resolves.toEqual({
      sessions: [{ createdAt: '2026-09-19T00:00:00.000Z', cwd: '/working', firstMessage: 'Original question', id: 'session-1', name: 'Existing session', updatedAt: nativeSession.updatedAt }],
    })
  })

  it('issues a runtime bootstrap token only to the configured origin', async () => {
    const securedApp = createApp(runtime as unknown as PiRuntimeRegistry, new RuntimeSecurity('http://localhost:5173'), undefined, sessionIndex.index)
    const rejected = await securedApp.request('/api/runtime/bootstrap', { method: 'POST' })
    expect(rejected.status).toBe(403)
    const accepted = await securedApp.request('/api/runtime/bootstrap', { method: 'POST', headers: { origin: 'http://localhost:5173' } })
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toMatchObject({ runtimeId: expect.any(String), websocketPath: '/api/runtime', token: expect.any(String) })
  })

  it('rejects stale tokens for initial session settings before creating a native session', async () => {
    const security = new RuntimeSecurity('http://localhost:5173')
    const route = createApp(runtime as unknown as PiRuntimeRegistry, security, undefined, sessionIndex.index)
    const body = JSON.stringify({ cwd: '/working', prompt: 'first', initialSettings: { thinkingLevel: 'high' } })
    const response = await route.request('/api/sessions', { method: 'POST', headers: { origin: security.origin, 'x-pi-nest-token': 'expired', 'content-type': 'application/json' }, body })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'RUNTIME_TOKEN_INVALID' })
    expect(createPiSession).not.toHaveBeenCalled()
    expect(runtime.beginPrompt).not.toHaveBeenCalled()
    const origin = await route.request('/api/sessions', { method: 'POST', headers: { origin: 'https://evil.example', 'x-pi-nest-token': 'expired', 'content-type': 'application/json' }, body })
    await expect(origin.json()).resolves.not.toHaveProperty('code')
  })

  it('reads safe history and rejects it while the runtime owns the session', async () => {
    const response = await app().request('/api/sessions/session-1/history')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ entries: [], hasEarlier: false, revision: 'a'.repeat(64), session: { cwd: '/working', id: 'session-1', updatedAt: nativeSession.updatedAt } })
    expect(readPiSessionHistory).toHaveBeenCalledWith({ expectedCwd: '/working', expectedSessionId: 'session-1', sessionFile: '/pi/session.jsonl' })
    runtime.isPromptStreaming.mockReturnValue(true)
    expect((await app().request('/api/sessions/session-1/history')).status).toBe(200)
  })

  it('passes the bounded stable cursor through to the native Turn page reader', async () => {
    readPiSessionHistory.mockReturnValue({ beforeCursor: 'user-41', entries: [{ id: 'user-80' }], hasEarlier: true, revision: 'a'.repeat(64) })

    const response = await app().request('/api/sessions/session-1/history?before=user-81&limit=40')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ beforeCursor: 'user-41', hasEarlier: true })
    expect(readPiSessionHistory).toHaveBeenCalledWith({ before: 'user-81', expectedCwd: '/working', expectedSessionId: 'session-1', limit: 40, sessionFile: '/pi/session.jsonl' })
    expect((await app().request('/api/sessions/session-1/history?limit=101')).status).toBe(400)
  })

  it('reads a complete lightweight Turn index separately from paged history bodies', async () => {
    readPiSessionTurnIndex.mockReturnValue({ entries: [{ id: 'user-1', index: 1, promptPreview: 'first', startedAt: '2026-09-21T00:00:00.000Z' }], revision: 'a'.repeat(64) })

    const response = await app().request('/api/sessions/session-1/turn-index')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ entries: [{ id: 'user-1', index: 1, promptPreview: 'first', startedAt: '2026-09-21T00:00:00.000Z' }], revision: 'a'.repeat(64) })
    expect(readPiSessionTurnIndex).toHaveBeenCalledWith({ expectedCwd: '/working', expectedSessionId: 'session-1', sessionFile: '/pi/session.jsonl' })
  })

  it('keeps an index and its body pages on the same native-session revision', async () => {
    const revision = 'b'.repeat(64)
    await app().request(`/api/sessions/session-1/history?revision=${revision}`)
    await app().request(`/api/sessions/session-1/turn-index?revision=${revision}`)

    expect(readPiSessionHistory).toHaveBeenLastCalledWith({ expectedCwd: '/working', expectedSessionId: 'session-1', revision, sessionFile: '/pi/session.jsonl' })
    expect(readPiSessionTurnIndex).toHaveBeenLastCalledWith({ expectedCwd: '/working', expectedSessionId: 'session-1', revision, sessionFile: '/pi/session.jsonl' })
  })

  it('allows running-session snapshots and distinguishes actual revision conflicts', async () => {
    runtime.isPromptStreaming.mockReturnValue(true)
    for (const route of ['history', 'turn-index']) {
      const response = await app().request(`/api/sessions/session-1/${route}`)
      expect(response.status).toBe(200)
    }
    expect(readPiSessionTurnIndex).toHaveBeenCalled()
    runtime.isPromptStreaming.mockReturnValue(false)
    readPiSessionTurnIndex.mockImplementation(() => { throw Object.assign(new adapter.PiSessionHistoryRevisionError(), { name: 'PiSessionHistoryRevisionError' }) })
    readPiSessionHistory.mockImplementation(() => { throw Object.assign(new adapter.PiSessionHistoryRevisionError(), { name: 'PiSessionHistoryRevisionError' }) })
    for (const route of ['history', 'turn-index']) {
      const response = await app().request(`/api/sessions/session-1/${route}?revision=${'a'.repeat(64)}`)
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ code: 'REVISION_CHANGED' })
    }
  })

  it('keeps native session mutations mutually exclusive through the runtime registry', async () => {
    const finish = vi.fn()
    runtime.beginMutation.mockReturnValueOnce(Promise.resolve(finish))
    const renamed = await app().request('/api/sessions/session-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(renamed.status).toBe(200)
    expect(renamePiSession).toHaveBeenCalledWith({ expectedCwd: '/working', expectedSessionId: 'session-1', name: 'Renamed', sessionFile: '/pi/session.jsonl' })
    expect(sessionIndex.invalidateCalls).toEqual(['/pi/session.jsonl'])
    expect(finish).toHaveBeenCalledOnce()
    runtime.beginMutation.mockReturnValueOnce(undefined)
    expect((await app().request('/api/sessions/session-1', { method: 'DELETE' })).status).toBe(409)
    expect(deletePiSession).not.toHaveBeenCalled()
  })

  it('removes the exact native file from the shared index after deletion', async () => {
    runtime.beginMutation.mockReturnValueOnce(Promise.resolve(vi.fn()))
    const response = await app().request('/api/sessions/session-1', { method: 'DELETE' })
    expect(response.status).toBe(204)
    expect(deletePiSession).toHaveBeenCalledWith({ expectedCwd: '/working', expectedSessionId: 'session-1', sessionFile: '/pi/session.jsonl' })
    expect(sessionIndex.forgetCalls).toEqual(['/pi/session.jsonl'])
    expect(runtime.deleteSession).toHaveBeenCalledWith('session-1')
  })

  it('creates a native session only when the first prompt is admitted, then exposes a safe summary', async () => {
    runtime.beginPrompt.mockReturnValue({ accepted: Promise.resolve(), settled: new Promise(() => undefined) })

    const response = await app().request('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/working', prompt: ' First prompt ' }),
    })

    expect(response.status).toBe(201)
    expect(createPiSession).toHaveBeenCalledWith('/working')
    expect(runtime.beginPrompt).toHaveBeenCalledWith({ createdAt: '2026-10-13T00:00:00.000Z', cwd: '/working', id: 'created-session', sessionFile: '/pi/created.jsonl' }, 'First prompt', undefined, undefined)
    await expect(response.json()).resolves.toMatchObject({ session: { createdAt: '2026-10-13T00:00:00.000Z', cwd: '/working', firstMessage: 'First prompt', id: 'created-session' } })
    expect(sessionIndex.registerCalls).toEqual([expect.objectContaining({ cwd: '/working', id: 'created-session', sessionFile: '/pi/created.jsonl' })])
    expect(sessionIndex.sessions).toContainEqual(expect.objectContaining({ firstMessage: 'First prompt', id: 'created-session' }))
  })

  it('validates and passes draft selections into first-prompt initialization', async () => {
    const security = new RuntimeSecurity('http://localhost:5173')
    const route = createApp(runtime as unknown as PiRuntimeRegistry, security, undefined, sessionIndex.index)
    const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/json' }
    const initialSettings = { model: { provider: 'test', id: 'reasoning' }, thinkingLevel: 'high' }
    const body = JSON.stringify({ cwd: '/working', prompt: 'First prompt', initialSettings })
    expect((await route.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(403)
    runtime.beginPrompt.mockReturnValue({ accepted: Promise.resolve(), settled: new Promise(() => undefined) })
    expect((await route.request('/api/sessions', { method: 'POST', headers, body })).status).toBe(201)
    expect(runtime.beginPrompt).toHaveBeenCalledWith(expect.objectContaining({ id: 'created-session' }), 'First prompt', undefined, initialSettings)
    expect((await route.request('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ cwd: '/working', prompt: 'first', initialSettings: { model: { id: '' } } }) })).status).toBe(400)
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
    expect(sessionIndex.forgetCalls).toEqual(['/pi/created.jsonl'])
    expect(sessionIndex.sessions).not.toContainEqual(expect.objectContaining({ id: 'created-session' }))
  })

  it('prepares an attachment once for a new session and transfers it before the first prompt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-app-attachment-'))
    const host = nativeHost()
    const registry = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: () => host as unknown as PiRuntimeHost })
    const security = new RuntimeSecurity('http://localhost:5173')
    const route = createApp(registry, security, undefined, sessionIndex.index)
    const draftId = crypto.randomUUID()
    const submissionId = crypto.randomUUID()
    try {
      const image = await registry.attachments.upload(imageStream(), `draft:${draftId}:/working`, 'photo.png', 'image/png')
      vi.mocked(preparePiImage).mockClear()
      const read = vi.spyOn(registry.attachments, 'read')

      const response = await route.request('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: security.origin, 'x-pi-nest-token': security.token },
        body: JSON.stringify({ cwd: '/working', draftId, prompt: '', attachmentIds: [image.id], submissionId }),
      })

      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({ session: { id: 'created-session' } })
      expect(createPiSession).toHaveBeenCalledWith('/working')
      expect(preparePiImage).toHaveBeenCalledTimes(1)
      expect(read.mock.calls.filter(([id]) => id === image.id)).toHaveLength(1)
      expect(host.beginPrompt).toHaveBeenCalledTimes(1)
      expect(host.beginPrompt).toHaveBeenCalledWith(expect.stringContaining(submissionId), [{ type: 'image', data: png, mimeType: 'image/png' }])
      expect(registry.attachments.read(image.id, 'created-session').ref).toEqual(image)
      expect(registry.attachments.receipt('created-session', { message: '', attachmentIds: [image.id], submissionId })).toMatchObject({ session: { id: 'created-session' } })
      read.mockRestore()
    } finally { await registry.close(); await rm(directory, { force: true, recursive: true }) }
  })

  it('rolls back a new session when its prepared attachment prompt is not admitted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-app-attachment-rollback-'))
    const host = nativeHost()
    const registry = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: () => host as unknown as PiRuntimeHost })
    const security = new RuntimeSecurity('http://localhost:5173')
    const route = createApp(registry, security, undefined, sessionIndex.index)
    const draftId = crypto.randomUUID()
    const submissionId = crypto.randomUUID()
    try {
      const image = await registry.attachments.upload(imageStream(), `draft:${draftId}:/working`, 'photo.png', 'image/png')
      vi.mocked(preparePiImage).mockClear()
      const beginPrompt = vi.spyOn(registry, 'beginPrompt').mockReturnValue(undefined)

      const response = await route.request('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: security.origin, 'x-pi-nest-token': security.token },
        body: JSON.stringify({ cwd: '/working', draftId, prompt: '', attachmentIds: [image.id], submissionId }),
      })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toEqual({ error: 'Pi runtime is busy' })
      expect(preparePiImage).toHaveBeenCalledTimes(1)
      expect(deletePiSession).toHaveBeenCalledWith({ expectedCwd: '/working', expectedSessionId: 'created-session', sessionFile: '/pi/created.jsonl' })
      expect(sessionIndex.forgetCalls).toEqual(['/pi/created.jsonl'])
      expect(registry.attachments.uncertainSession(`draft:${draftId}:/working`, { message: '', attachmentIds: [image.id], submissionId })).toBeUndefined()
      beginPrompt.mockRestore()
    } finally { await registry.close(); await rm(directory, { force: true, recursive: true }) }
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
    const response = await app().request('/api/projects/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/working' }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({ requested: true })
    expect(revealPiWorkspace).toHaveBeenCalledWith('/working')

    expect((await app().request('/api/projects/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/unknown' }),
    })).status).toBe(404)
    expect(revealPiWorkspace).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['PROJECT_FOLDER_UNAVAILABLE', 404, '项目文件夹不存在或该路径不是文件夹。'],
    ['PROJECT_FOLDER_ACCESS_DENIED', 403, '没有访问项目文件夹的权限。'],
    ['PROJECT_FOLDER_UNSUPPORTED', 501, '当前系统不支持打开项目文件夹。'],
    ['PROJECT_FOLDER_OPEN_FAILED', 500, '无法启动系统文件管理器，请确认当前系统支持桌面操作。'],
  ])('reports %s without exposing launcher or filesystem details', async (code, status, error) => {
    revealPiWorkspace.mockRejectedValueOnce(Object.assign(new Error('private internal path'), { code }))
    const response = await app().request('/api/projects/reveal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/working' }),
    })
    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ code, error })
  })

})

it('lists native parent relationships without exposing file paths', async () => {
  sessionIndex.setSessions([
    nativeSession,
    { ...nativeSession, id: 'child', sessionFile: '/private/child.jsonl', parentSessionPath: nativeSession.sessionFile },
    { ...nativeSession, id: 'orphan', sessionFile: '/private/orphan.jsonl', parentSessionPath: '/private/missing.jsonl' },
  ])
  const response = await createApp(runtimeMock() as unknown as PiRuntimeRegistry, undefined, undefined, sessionIndex.index).request('/api/sessions')
  const body = await response.json()
  expect(response.status).toBe(200)
  expect(body.sessions[1].parentSessionId).toBe(nativeSession.id)
  expect(body.sessions[2].parentSessionMissing).toBe(true)
  expect(JSON.stringify(body)).not.toContain('/private/')
  for (const session of body.sessions) {
    expect(session).not.toHaveProperty('sessionFile')
    expect(session).not.toHaveProperty('parentSessionPath')
  }
})

describe('branch creation', () => {
  it('creates a native branch under the source mutation lock and returns only safe fields', async () => {
    sessionIndex.setSessions([nativeSession])
    adapter.branchPiSession.mockReturnValue({ session: { id: 'child', cwd: '/working', createdAt: 'now', sessionFile: '/private/child.jsonl' }, draft: 'selected text' })
    const registry = runtimeMock()
    const finish = vi.fn()
    const source = Buffer.from('validated source')
    adapter.readPiSessionForkSource.mockReturnValue(source)
    registry.beginMutation.mockImplementationOnce(async (_sessionId, beforeUnload) => { beforeUnload?.(); return finish })
    const response = await createApp(registry as unknown as PiRuntimeRegistry, undefined, undefined, sessionIndex.index).request('/api/sessions/session-1/branch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'fork', entryId: 'user-1', revision: 'a'.repeat(64) }) })
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body).toEqual({ session: { id: 'child', cwd: '/working', createdAt: 'now', updatedAt: 'now', parentSessionId: 'session-1' }, draft: 'selected text' })
    expect(adapter.readPiSessionForkSource).toHaveBeenCalledWith({ sessionFile: nativeSession.sessionFile, revision: 'a'.repeat(64) })
    expect(adapter.branchPiSession).toHaveBeenCalledWith({ expectedSessionId: nativeSession.id, expectedCwd: nativeSession.cwd, sessionFile: nativeSession.sessionFile, kind: 'fork', entryId: 'user-1', revision: 'a'.repeat(64) }, source)
    expect(finish).toHaveBeenCalledOnce()
    expect(sessionIndex.registerCalls).toEqual([expect.objectContaining({ cwd: '/working', id: 'child', sessionFile: '/private/child.jsonl' })])
  })
  it('rejects malformed, busy, missing and stale branch operations', async () => {
    sessionIndex.setSessions([nativeSession])
    adapter.branchPiSession.mockClear()
    const registry = runtimeMock()
    const app = createApp(registry as unknown as PiRuntimeRegistry, undefined, undefined, sessionIndex.index)
    const send = (body: unknown, id = 'session-1') => app.request(`/api/sessions/${id}/branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await send({ kind: 'fork', revision: 'a'.repeat(64) })).status).toBe(400)
    expect((await send({ kind: 'clone', revision: 'bad' })).status).toBe(400)
    expect((await send({ kind: 'clone' }, 'missing')).status).toBe(404)
    registry.beginMutation.mockReturnValueOnce(undefined as never)
    expect((await send({ kind: 'clone' })).status).toBe(409)
    expect(adapter.branchPiSession).not.toHaveBeenCalled()
    const finish = vi.fn()
    registry.beginMutation.mockResolvedValue(finish)
    adapter.branchPiSession.mockImplementationOnce(() => { throw new adapter.PiSessionHistoryRevisionError() })
    const stale = await send({ kind: 'fork', entryId: 'user-1', revision: 'a'.repeat(64) })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'HISTORY_REVISION_CHANGED' })
    expect(finish).toHaveBeenCalledOnce()
  })
})
