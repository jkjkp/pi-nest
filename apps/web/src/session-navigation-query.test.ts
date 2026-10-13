import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { sessionHistoryQueryKey, sessionTurnIndexQueryKey, type PiSessionHistoryResponse } from './history.js'
import { fetchSessionNavigation } from './session-navigation-query.js'
import { fetchSessionHistory, RequestError } from './workspace-api.js'

afterEach(() => vi.unstubAllGlobals())
const history = (revision: string) => ({ entries: [], hasEarlier: false, revision, session: { id: 'session' } }) as PiSessionHistoryResponse
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

it('refreshes once and atomically replaces old history pages and the index cache', async () => {
  const client = new QueryClient()
  client.setQueryData(sessionHistoryQueryKey('session'), { pages: [history('old'), history('old')], pageParams: [{}, { before: 'earlier', revision: 'old' }] })
  client.setQueryData(['session-history-page', 'session', 'old'], history('old'))
  const fetch = vi.fn().mockResolvedValueOnce(json({ code: 'REVISION_CHANGED' }, 409)).mockResolvedValueOnce(json(history('new'))).mockResolvedValueOnce(json({ entries: [], revision: 'new' }))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  const index = await fetchSessionNavigation('session', 'old', signal, client)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/sessions/session/turn-index?revision=old', '/api/sessions/session/history?limit=40', '/api/sessions/session/turn-index?revision=new'])
  expect(fetch.mock.calls.every(([, options]) => options.signal === signal)).toBe(true)
  expect(client.getQueryData(sessionHistoryQueryKey('session'))).toEqual({ pages: [history('new')], pageParams: [{}] })
  expect(client.getQueryData(['session-history-page', 'session', 'old'])).toBeUndefined()
  expect(client.getQueryData(sessionTurnIndexQueryKey('session', 'new'))).toEqual(index)
  client.clear()
})

it.each(['REVISION_CHANGED', 'SESSION_RUNNING'])('stops if recovery conflicts again with %s and retains the readable snapshot', async (code) => {
  const client = new QueryClient()
  const cached = { pages: [history('old')], pageParams: [{}] }
  client.setQueryData(sessionHistoryQueryKey('session'), cached)
  const fetch = vi.fn().mockResolvedValueOnce(json({ code: 'REVISION_CHANGED' }, 409)).mockResolvedValueOnce(json(history('new'))).mockResolvedValueOnce(json({ code }, 409))
  vi.stubGlobal('fetch', fetch)
  await expect(fetchSessionNavigation('session', 'old', new AbortController().signal, client)).rejects.toMatchObject({ code, status: 409 })
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(client.getQueryData(sessionHistoryQueryKey('session'))).toEqual(cached)
  client.clear()
})

it.each([['SESSION_RUNNING', 409], ['CWD_UNAVAILABLE', 409], [undefined, 500]])('does not automatically retry %s (%s)', async (code, status) => {
  const fetch = vi.fn().mockResolvedValue(json({ code }, status))
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient()
  await expect(fetchSessionNavigation('session', 'old', new AbortController().signal, client)).rejects.toBeInstanceOf(RequestError)
  expect(fetch).toHaveBeenCalledTimes(1)
  client.clear()
})

it('does not replace caches if the recovery request was aborted during a session switch', async () => {
  const client = new QueryClient()
  const controller = new AbortController()
  const fetch = vi.fn().mockResolvedValueOnce(json({ code: 'REVISION_CHANGED' }, 409)).mockResolvedValueOnce(json(history('new'))).mockImplementationOnce(async () => {
    controller.abort()
    return json({ entries: [], revision: 'new' })
  })
  vi.stubGlobal('fetch', fetch)
  await expect(fetchSessionNavigation('session', 'old', controller.signal, client)).rejects.toMatchObject({ name: 'AbortError' })
  expect(client.getQueryData(sessionHistoryQueryKey('session'))).toBeUndefined()
  expect(client.getQueryData(sessionTurnIndexQueryKey('session', 'new'))).toBeUndefined()
  client.clear()
})

it('retains the HTTP status when an error response is not JSON', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Proxy error', { status: 502 })))
  await expect(fetchSessionHistory('session')).rejects.toMatchObject({ status: 502, code: undefined })
})

it('reuses the recovered index when the history revision switches the observed query key', async () => {
  const client = new QueryClient()
  const fetch = vi.fn().mockResolvedValueOnce(json({ code: 'REVISION_CHANGED' }, 409)).mockResolvedValueOnce(json(history('new'))).mockResolvedValueOnce(json({ entries: [], revision: 'new' }))
  vi.stubGlobal('fetch', fetch)
  const options = (revision: string) => ({ queryKey: sessionTurnIndexQueryKey('session', revision), queryFn: ({ signal }: { signal: AbortSignal }) => fetchSessionNavigation('session', revision, signal, client), staleTime: Infinity, retry: false as const })
  const observer = new QueryObserver(client, options('old'))
  const unsubscribeCache = client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.query.queryKey[0] === 'session-history' && client.getQueryData(sessionTurnIndexQueryKey('session', 'new'))) observer.setOptions(options('new'))
  })
  const unsubscribe = observer.subscribe(() => {})
  try {
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.revision).toBe('new'))
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(observer.getCurrentResult().isError).toBe(false)
  } finally { unsubscribe(); unsubscribeCache(); client.clear() }
})

it('keeps cancellation distinct from HTTP failure when reading an error response is aborted', async () => {
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => {
    controller.abort()
    throw controller.signal.reason
  } }))
  await expect(fetchSessionHistory('session', undefined, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
