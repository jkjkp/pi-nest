import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let fetchSessionFilePreview: typeof import('./workspace-api.js')['fetchSessionFilePreview']
let fetchSessionImagePreview: typeof import('./workspace-api.js')['fetchSessionImagePreview']
beforeEach(async () => {
  vi.resetModules()
  ;({ fetchSessionFilePreview, fetchSessionImagePreview } = await import('./workspace-api.js'))
})

afterEach(() => vi.unstubAllGlobals())

it('fetches image bytes with the existing bootstrap token, encoded session id and abort signal', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ runtimeId: 'runtime-1', token: 'session-token', websocketPath: '/api/runtime' })).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png', 'x-pi-nest-file-path': encodeURIComponent('images/图片.png') } }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new AbortController()
  const result = await fetchSessionImagePreview('session/one', '图片.png', controller.signal, 'images')
  expect(fetcher.mock.calls[0]).toEqual(['/api/runtime/bootstrap', { method: 'POST', cache: 'no-store', signal: expect.any(AbortSignal) }])
  expect(fetcher.mock.calls[0][1].signal).not.toBe(controller.signal)
  expect(fetcher.mock.calls[1]).toEqual(['/api/sessions/session%2Fone/file-preview/image', expect.objectContaining({ method: 'POST', headers: expect.any(Headers), cache: 'no-store', signal: controller.signal, body: JSON.stringify({ path: '图片.png', searchRoot: 'images' }) })])
  expect(fetcher.mock.calls[1][1].headers.get('x-pi-nest-token')).toBe('session-token')
  expect(result.path).toBe('images/图片.png')
  expect(result.blob.type).toBe('image/png')
  expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
})

it('keeps text JSON requests compatible and surfaces image authorization and format failures', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  fetcher.mockResolvedValueOnce(Response.json({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' })).mockResolvedValueOnce(Response.json({ path: 'a.ts', content: 'text' }))
  expect(await fetchSessionFilePreview('one', 'a.ts')).toEqual({ path: 'a.ts', content: 'text' })
  fetcher.mockResolvedValueOnce(Response.json({ error: '图片格式无效。' }, { status: 415 }))
  await expect(fetchSessionImagePreview('one', 'a.png')).rejects.toThrow('图片格式无效。')
  fetcher.mockResolvedValueOnce(new Response('denied', { status: 403 }))
  await expect(fetchSessionImagePreview('one', 'a.png')).rejects.toThrow('请求失败，请重试。')
  fetcher.mockResolvedValueOnce(new Response('proxy error', { status: 502 }))
  await expect(fetchSessionImagePreview('one', 'a.png')).rejects.toThrow('请求失败，请重试。')
})

it('does not request file contents when bootstrap is denied', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('denied', { status: 403 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(fetchSessionImagePreview('one', 'a.png')).rejects.toThrow('无法验证访问权限')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
