import { describe, expect, it } from 'vitest'

import { sessionHistoryQueryKey, type PiSessionHistoryResponse } from './history.js'

describe('session history presentation contract', () => {
  it('keeps history cache isolated by session ID', () => {
    expect(sessionHistoryQueryKey('first')).toEqual(['session-history', 'first'])
    expect(sessionHistoryQueryKey('second')).not.toEqual(sessionHistoryQueryKey('first'))
  })

  it('models complete native timeline entries for the browser', () => {
    const response: PiSessionHistoryResponse = {
      entries: [
        {
          id: 'assistant-1',
          parentId: 'user-1',
          raw: { id: 'assistant-1', message: { content: 'raw text', role: 'assistant' }, nested: { value: true }, type: 'message' },
          timestamp: '2026-09-21T00:00:00.000Z',
          type: 'message',
        },
      ],
      hasEarlier: false,
      session: { cwd: '/safe/project', id: 'session-1', updatedAt: '2026-09-21T00:00:00.000Z' },
    }

    expect(response.entries[0]?.raw).toMatchObject({ nested: { value: true } })
  })
})
