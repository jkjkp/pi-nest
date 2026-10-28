import { QueryClient } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { fetchHistoryView, type HistoryPages } from './history-view.js'
import { sessionHistoryQueryKey, sessionTurnIndexQueryKey, type PiSessionHistoryResponse } from './history.js'
import { fetchSessionHistory, fetchSessionTurnIndex } from './workspace-api.js'

vi.mock('./workspace-api.js', () => ({ fetchSessionHistory: vi.fn(), fetchSessionTurnIndex: vi.fn() }))
beforeEach(() => { vi.mocked(fetchSessionHistory).mockReset(); vi.mocked(fetchSessionTurnIndex).mockReset() })
const page = (id: string, revision: string, hasEarlier = false): PiSessionHistoryResponse => ({
  session: { id: 'one' }, revision, hasEarlier, ...(hasEarlier ? { beforeCursor: id } : {}),
  entries: [{ id, parentId: null, type: 'message', timestamp: `2026-10-17T00:00:0${id}Z`, raw: { message: { role: 'user', content: id } } }],
})
it('includes history loaded by the reader while the next version is being prepared', async () => {
  const client = new QueryClient()
  const key = sessionHistoryQueryKey('one')
  client.setQueryData<HistoryPages>(key, { pages: [page('2', 'old')], pageParams: [{}] })
  let resolve!: (value: PiSessionHistoryResponse) => void
  vi.mocked(fetchSessionHistory).mockReset().mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    .mockResolvedValueOnce(page('2', 'new', true)).mockResolvedValueOnce(page('1', 'new'))
  vi.mocked(fetchSessionTurnIndex).mockResolvedValue({ revision: 'new', entries: ['1', '2', '3'].map((id, index) => ({ id, index, promptPreview: id, startedAt: '2026-10-17T00:00:00Z' })) })
  try {
    const result = fetchHistoryView('one', new AbortController().signal, client)
    client.setQueryData<HistoryPages>(key, { pages: [page('1', 'old'), page('2', 'old')], pageParams: [{}, {}] })
    resolve(page('3', 'new', true))
    expect((await result).pages.map((value) => value.entries[0]?.id)).toEqual(['1', '2', '3'])
    expect(client.getQueryData<HistoryPages>(key)?.pages[0]?.revision).toBe('old')
    expect(client.getQueryData(sessionTurnIndexQueryKey('one', 'new'))).toEqual(await vi.mocked(fetchSessionTurnIndex).mock.results[0]!.value)
    expect(fetchSessionTurnIndex).toHaveBeenCalledTimes(1)
  } finally { client.clear() }
})

it.each(['missing', 'same', 'other-session', 'other-revision', 'wrong-data'])('uses only an accurate cached index when the cache is %s', async (cache) => {
  const client = new QueryClient()
  const index = { revision: 'new', entries: [{ id: '1', index: 1, promptPreview: 'oldest', startedAt: 'now' }] }
  client.setQueryData<HistoryPages>(sessionHistoryQueryKey('one'), { pages: [page('1', 'old')], pageParams: [{}] })
  if (cache !== 'missing') {
    client.setQueryData(sessionTurnIndexQueryKey(cache === 'other-session' ? 'two' : 'one', cache === 'other-revision' ? 'old' : 'new'), { ...index, revision: cache === 'wrong-data' || cache === 'other-revision' ? 'old' : 'new' })
  }
  vi.mocked(fetchSessionHistory).mockResolvedValueOnce(page('3', 'new', true)).mockResolvedValueOnce(page('1', 'new'))
  vi.mocked(fetchSessionTurnIndex).mockResolvedValue(index)
  try {
    expect((await fetchHistoryView('one', new AbortController().signal, client)).pages.map((value) => value.entries[0]?.id)).toEqual(['1', '3'])
    expect(fetchSessionTurnIndex).toHaveBeenCalledTimes(cache === 'same' ? 0 : 1)
    expect(client.getQueryData(sessionTurnIndexQueryKey('one', 'new'))).toEqual(index)
  } finally { client.clear() }
})

it.each(['cancelled', 'wrong-revision', 'failed'])('does not cache an index or replace readable history when the index request is %s', async (failure) => {
  const client = new QueryClient()
  const controller = new AbortController()
  const old = { pages: [page('1', 'old')], pageParams: [{}] }
  client.setQueryData(sessionHistoryQueryKey('one'), old)
  vi.mocked(fetchSessionHistory).mockResolvedValue(page('3', 'new', true))
  vi.mocked(fetchSessionTurnIndex).mockImplementation(async () => {
    if (failure === 'failed') throw new Error('index unavailable')
    if (failure === 'cancelled') controller.abort()
    return { entries: [], revision: failure === 'wrong-revision' ? 'unexpected' : 'new' }
  })
  try {
    await expect(fetchHistoryView('one', controller.signal, client)).rejects.toThrow()
    expect(client.getQueryData(sessionTurnIndexQueryKey('one', 'new'))).toBeUndefined()
    expect(client.getQueryData(sessionHistoryQueryKey('one'))).toEqual(old)
  } finally { client.clear() }
})

it('does not request an index when the latest page already covers the loaded range', async () => {
  const client = new QueryClient()
  vi.mocked(fetchSessionHistory).mockResolvedValue(page('1', 'new'))
  try {
    await fetchHistoryView('one', new AbortController().signal, client)
    expect(fetchSessionTurnIndex).not.toHaveBeenCalled()
  } finally { client.clear() }
})
