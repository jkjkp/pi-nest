import { QueryClient } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { fetchHistoryView, type HistoryPages } from './history-view.js'
import { sessionHistoryQueryKey, type PiSessionHistoryResponse } from './history.js'
import { fetchSessionHistory, fetchSessionTurnIndex } from './workspace-api.js'

vi.mock('./workspace-api.js', () => ({ fetchSessionHistory: vi.fn(), fetchSessionTurnIndex: vi.fn() }))
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
  } finally { client.clear() }
})
