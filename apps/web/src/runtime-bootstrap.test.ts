import { afterEach, expect, it, vi } from 'vitest'
import { createRuntimeBootstrap } from './runtime-bootstrap.js'

const credentials = { runtimeId: 'runtime-1', token: 'token-1', websocketPath: '/api/runtime' }
afterEach(() => vi.restoreAllMocks())

it('shares a cold bootstrap and reuses credentials until explicitly refreshed', async () => {
  let release!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const bootstrap = createRuntimeBootstrap(fetcher)
  const requests = Array.from({ length: 8 }, () => bootstrap.get())
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(requests.every((request) => request === requests[0])).toBe(true)
  release(Response.json(credentials))
  expect(await Promise.all(requests)).toEqual(Array(8).fill(credentials))
  expect(await bootstrap.get()).toEqual(credentials)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('coalesces refreshes and ignores late invalidations using older credentials', async () => {
  const next = { ...credentials, runtimeId: 'runtime-2', token: 'token-2' }
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(credentials))
  const bootstrap = createRuntimeBootstrap(fetcher)
  const old = await bootstrap.get()
  fetcher.mockImplementation(async () => Response.json(next))
  const results = await Promise.all(Array.from({ length: 8 }, () => bootstrap.refresh(old)))
  expect(results).toEqual(Array(8).fill(next))
  bootstrap.invalidate(old)
  expect(await bootstrap.refresh(old)).toEqual(next)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('does not start overlapping bootstraps when a connection requests a fresh credential', async () => {
  let release!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const bootstrap = createRuntimeBootstrap(fetcher)
  const first = bootstrap.get()
  const refreshed = bootstrap.refresh()
  expect(refreshed).toBe(first)
  release(Response.json(credentials))
  await first
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each(['denied', 'invalid', 'network'])('does not cache a %s bootstrap failure', async (failure) => {
  const fetcher = vi.fn<typeof fetch>()
  if (failure === 'network') fetcher.mockRejectedValueOnce(new Error('offline'))
  else fetcher.mockResolvedValueOnce(failure === 'denied' ? new Response(null, { status: 403 }) : Response.json({ token: 'incomplete' }))
  fetcher.mockResolvedValueOnce(Response.json(credentials))
  const bootstrap = createRuntimeBootstrap(fetcher)
  await expect(bootstrap.get()).rejects.toThrow()
  expect(await bootstrap.get()).toEqual(credentials)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('cancels one waiter without cancelling shared bootstrap or another waiter', async () => {
  let release!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const bootstrap = createRuntimeBootstrap(fetcher)
  const controller = new AbortController()
  const cancelled = bootstrap.get(controller.signal)
  const remaining = bootstrap.get()
  controller.abort()
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  expect((fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(false)
  release(Response.json(credentials))
  expect(await remaining).toEqual(credentials)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('does not start a bootstrap for an already cancelled caller', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const bootstrap = createRuntimeBootstrap(fetcher)
  await expect(bootstrap.get(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('uses an independent timeout and permits a new attempt after it expires', async () => {
  const deadline = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
  })).mockResolvedValueOnce(Response.json(credentials))
  const bootstrap = createRuntimeBootstrap(fetcher)
  const request = bootstrap.get()
  deadline.abort(new DOMException('timed out', 'TimeoutError'))
  await expect(request).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(await bootstrap.get()).toEqual(credentials)
})
