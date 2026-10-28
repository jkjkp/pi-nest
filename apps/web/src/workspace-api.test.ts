import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const credentials = { runtimeId: 'runtime-1', token: 'token-1', websocketPath: '/api/runtime' }
const updated = { ...credentials, runtimeId: 'runtime-2', token: 'token-2' }
const expired = () => Response.json({ error: '凭据失效', code: 'RUNTIME_TOKEN_INVALID' }, { status: 403 })
let api: typeof import('./workspace-api.js')
beforeEach(async () => { vi.resetModules(); api = await import('./workspace-api.js') })
afterEach(() => vi.unstubAllGlobals())

it('uses one bootstrap for concurrent thumbnails and later business requests', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => url === '/api/runtime/bootstrap'
    ? Response.json(credentials) : new Response('image'))
  vi.stubGlobal('fetch', fetcher)
  await Promise.all(Array.from({ length: 8 }, (_, i) => api.configurationResponse(`/images/${i}`, { method: 'POST', body: '{}' })))
  await api.configurationResponse('/configuration')
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/runtime/bootstrap')).toHaveLength(1)
  expect(fetcher).toHaveBeenCalledTimes(10)
})

it('refreshes once for concurrent expired requests and retries each with the new token', async () => {
  let bootstraps = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (url === '/api/runtime/bootstrap') return Response.json(++bootstraps === 1 ? credentials : updated)
    return new Headers(init!.headers).get('x-pi-nest-token') === credentials.token ? expired() : Response.json({ ok: true })
  })
  vi.stubGlobal('fetch', fetcher)
  const results = await Promise.all(Array.from({ length: 8 }, () => api.configurationRequest('/configuration')))
  expect(results).toEqual(Array(8).fill({ ok: true }))
  expect(bootstraps).toBe(2)
  expect(fetcher).toHaveBeenCalledTimes(18)
})

it('uses refreshed credentials when an older failure arrives late', async () => {
  let bootstraps = 0
  let release!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (url === '/api/runtime/bootstrap') return Response.json(++bootstraps === 1 ? credentials : updated)
    if (new Headers(init!.headers).get('x-pi-nest-token') === updated.token) return Response.json({ ok: true })
    if (url === '/late') return new Promise<Response>((resolve) => { release = resolve })
    return expired()
  })
  vi.stubGlobal('fetch', fetcher)
  const late = api.configurationResponse('/late')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await api.configurationResponse('/early')
  release(expired())
  expect((await late).ok).toBe(true)
  expect(bootstraps).toBe(2)
})

it.each([
  [403, { error: 'Origin 被拒绝' }],
  [403, { error: '附件不属于当前会话', code: 'ATTACHMENT_FORBIDDEN' }],
  [500, { error: '保存失败', code: 'RUNTIME_TOKEN_INVALID', sessionId: 'retained' }],
] as const)('does not replay a business rejection (%s, %j)', async (status, body) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(credentials)).mockResolvedValueOnce(Response.json(body, { status }))
  vi.stubGlobal('fetch', fetcher)
  await expect(api.configurationResponse('/mutation', { method: 'POST', body: '{}' })).rejects.toMatchObject({ message: body.error })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('preserves error codes and uncertain session IDs', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(credentials)).mockResolvedValueOnce(Response.json({ error: '待确认', code: 'SUBMISSION_UNKNOWN', sessionId: 'retained' }, { status: 409 })))
  await expect(api.configurationResponse('/sessions', { method: 'POST', body: '{}' })).rejects.toMatchObject({ message: '待确认', code: 'SUBMISSION_UNKNOWN', sessionId: 'retained' })
})

it('does not replay a request after a connection failure', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(credentials)).mockRejectedValueOnce(new Error('offline'))
  vi.stubGlobal('fetch', fetcher)
  await expect(api.configurationResponse('/sessions', { method: 'POST', body: '{}' })).rejects.toThrow('offline')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('stops after one authentication retry', async () => {
  let bootstraps = 0
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => url === '/api/runtime/bootstrap'
    ? Response.json(++bootstraps === 1 ? credentials : updated) : expired())
  vi.stubGlobal('fetch', fetcher)
  await expect(api.configurationResponse('/sessions', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'RUNTIME_TOKEN_INVALID' })
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(bootstraps).toBe(2)
})

it('replays File uploads with their original bytes and custom Headers', async () => {
  const file = new File(['uploaded bytes'], 'photo.png', { type: 'image/png' })
  const bodies: string[] = []
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(credentials)).mockImplementation(async (url, init) => {
    if (url === '/api/runtime/bootstrap') return Response.json(updated)
    expect(init!.body).toBe(file)
    bodies.push(await new Response(init!.body).text())
    const headers = new Headers(init!.headers)
    expect(headers.get('content-type')).toBe('application/octet-stream')
    expect(headers.get('x-pi-nest-file-name')).toBe('photo.png')
    return headers.get('x-pi-nest-token') === credentials.token ? expired() : Response.json({ uploaded: true })
  })
  vi.stubGlobal('fetch', fetcher)
  await api.configurationResponse('/attachments', { method: 'POST', body: file, headers: new Headers({ 'content-type': 'application/octet-stream', 'x-pi-nest-file-name': 'photo.png', 'x-pi-nest-token': 'caller-stale-token' }) })
  expect(bodies).toEqual(['uploaded bytes', 'uploaded bytes'])
})

it('refreshes credentials without replaying a consumed stream body', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(credentials)).mockResolvedValueOnce(expired()).mockResolvedValueOnce(Response.json(updated)).mockResolvedValueOnce(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetcher)
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close() } })
  await expect(api.configurationResponse('/upload', { method: 'POST', body: stream })).rejects.toMatchObject({ code: 'RUNTIME_TOKEN_INVALID' })
  expect(fetcher).toHaveBeenCalledTimes(3)
  await api.configurationResponse('/configuration')
  expect(new Headers(fetcher.mock.calls[3]![1]!.headers).get('x-pi-nest-token')).toBe(updated.token)
})

it('aborts one thumbnail waiter without sending its business request or cancelling others', async () => {
  let release!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => { release = resolve })).mockResolvedValue(new Response('image'))
  vi.stubGlobal('fetch', fetcher)
  const controller = new AbortController()
  const cancelled = api.configurationResponse('/cancelled', { signal: controller.signal })
  const remaining = api.configurationResponse('/remaining')
  controller.abort()
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  release(Response.json(credentials))
  await remaining
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/runtime/bootstrap', '/remaining'])
})
