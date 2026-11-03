import { afterEach, expect, it, vi } from 'vitest'
import { branchSession } from './workspace-api.js'
afterEach(() => vi.unstubAllGlobals())
it('uses the supplied operation identity and treats lost or unreadable acknowledgements as uncertain', async () => {
  const operationId = crypto.randomUUID()
  const fetch = vi.fn().mockResolvedValueOnce(new Response('broken', { status: 201 })).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({ state: 'pending', operationId }, { status: 202 }))
  vi.stubGlobal('fetch', fetch)
  for (let i = 0; i < 3; i++) await expect(branchSession('source', { kind: 'clone', operationId })).rejects.toMatchObject({ uncertain: true })
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ kind: 'clone', operationId })
})
it('allows a new operation after a definite validation error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'invalid target' }, { status: 400 })))
  await expect(branchSession('source', { kind: 'clone', operationId: crypto.randomUUID() })).rejects.toMatchObject({ uncertain: false, message: 'invalid target' })
})
