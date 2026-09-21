import { beforeEach, describe, expect, it, vi } from 'vitest'

const listPiSessions = vi.fn()
const promptPiSession = vi.fn()

vi.mock('@pi-nest/pi-adapter', () => ({ listPiSessions, promptPiSession }))

const nativeSession = {
  cwd: '/working',
  id: 'session-1',
  sessionFile: '/pi/session.jsonl',
  updatedAt: '2026-09-21T00:00:00.000Z',
}

const completed = {
  cwd: '/working',
  id: 'session-1',
  messageCountAfter: 3,
  messageCountBefore: 1,
  model: { provider: 'provider', id: 'model' },
  stopReason: 'stop',
  textDeltaCount: 1,
  toolEventCount: 0,
}

describe('Pi Nest API', () => {
  beforeEach(() => {
    listPiSessions.mockReset()
    promptPiSession.mockReset()
    listPiSessions.mockResolvedValue([nativeSession])
    promptPiSession.mockImplementation(async ({ onTextDelta }) => {
      onTextDelta?.('OK')
      return completed
    })
  })

  it('reports that the local server is ready', async () => {
    const { app } = await import('./app.js')
    const response = await app.request('/api/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('lists safe native session summaries without file paths', async () => {
    const { app } = await import('./app.js')
    const response = await app.request('/api/sessions')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      sessions: [
        {
          cwd: '/working',
          id: 'session-1',
          updatedAt: '2026-09-21T00:00:00.000Z',
        },
      ],
    })
    expect(JSON.stringify(body)).not.toContain('sessionFile')
  })

  it('validates prompt requests and missing sessions', async () => {
    const { app } = await import('./app.js')
    const invalid = await app.request('/api/sessions/session-1/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '   ', extra: true }),
    })
    expect(invalid.status).toBe(400)

    listPiSessions.mockResolvedValueOnce([])
    const missing = await app.request('/api/sessions/missing/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'prompt' }),
    })
    expect(missing.status).toBe(404)
  })

  it('streams ordered text and completion events', async () => {
    const { app } = await import('./app.js')
    const response = await app.request('/api/sessions/session-1/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'prompt' }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('event: text_delta\ndata: {"delta":"OK"}')
    expect(body).toContain(
      'event: complete\ndata: {"model":{"provider":"provider","id":"model"},"stopReason":"stop","textDeltaCount":1}',
    )
    expect(body.indexOf('event: text_delta')).toBeLessThan(body.indexOf('event: complete'))
    expect(promptPiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCwd: '/working',
        expectedSessionId: 'session-1',
        prompt: 'prompt',
        sessionFile: '/pi/session.jsonl',
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('rejects concurrent prompts for the same session and releases the lock', async () => {
    let release: ((value: typeof completed) => void) | undefined
    promptPiSession.mockImplementation(
      () => new Promise<typeof completed>((resolve) => (release = resolve)),
    )
    const { app } = await import('./app.js')
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'prompt' }),
    }
    const first = await app.request('/api/sessions/session-1/prompts', request)
    await vi.waitFor(() => expect(promptPiSession).toHaveBeenCalledOnce())

    const concurrent = await app.request('/api/sessions/session-1/prompts', request)
    expect(concurrent.status).toBe(409)

    release?.(completed)
    await first.text()

    promptPiSession.mockResolvedValue(completed)
    const after = await app.request('/api/sessions/session-1/prompts', request)
    expect(after.status).toBe(200)
    await after.text()
  })

  it('emits a safe error and releases the lock after adapter failure', async () => {
    promptPiSession.mockRejectedValueOnce(new Error('/secret/session.jsonl failed'))
    const { app } = await import('./app.js')
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'prompt' }),
    }
    const failed = await app.request('/api/sessions/session-1/prompts', request)
    const body = await failed.text()

    expect(body).toContain(
      'event: error\ndata: {"code":"PROMPT_FAILED","message":"Pi session prompt failed"}',
    )
    expect(body).not.toContain('/secret')

    const after = await app.request('/api/sessions/session-1/prompts', request)
    expect(after.status).toBe(200)
    await after.text()
  })

  it('aborts the adapter when the response stream is cancelled', async () => {
    let signal: AbortSignal | undefined
    promptPiSession.mockImplementation(
      ({ signal: nextSignal }) =>
        new Promise<typeof completed>((resolve) => {
          signal = nextSignal
          nextSignal.addEventListener(
            'abort',
            () => resolve({ ...completed, stopReason: 'aborted' }),
            { once: true },
          )
        }),
    )
    const { app } = await import('./app.js')
    const response = await app.request('/api/sessions/session-1/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'prompt' }),
    })
    await vi.waitFor(() => expect(signal).toBeDefined())

    await response.body?.cancel()
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))

    promptPiSession.mockResolvedValue(completed)
    await vi.waitFor(async () => {
      const after = await app.request('/api/sessions/session-1/prompts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'prompt' }),
      })
      expect(after.status).toBe(200)
      await after.text()
    })
  })
})
