import { describe, expect, it } from 'vitest'

import { sessionHistoryQueryKey, type PiSessionHistoryResponse } from './history.js'

describe('session history presentation contract', () => {
  it('keeps history cache isolated by session ID', () => {
    expect(sessionHistoryQueryKey('first')).toEqual(['session-history', 'first'])
    expect(sessionHistoryQueryKey('second')).not.toEqual(sessionHistoryQueryKey('first'))
  })

  it('models only safe timeline entries for the browser', () => {
    const response: PiSessionHistoryResponse = {
      entries: [
        {
          id: 'assistant-1',
          kind: 'message',
          role: 'assistant',
          stopReason: 'aborted',
          text: 'safe text',
          timestamp: '2026-09-21T00:00:00.000Z',
        },
        {
          count: 2,
          kind: 'omitted',
          label: '未展示的原生事件',
          timestamp: '2026-09-21T00:00:01.000Z',
        },
      ],
      hasEarlier: false,
      session: { cwd: '/safe/project', id: 'session-1', updatedAt: '2026-09-21T00:00:00.000Z' },
    }

    expect(response.entries[1]).toMatchObject({ count: 2, label: '未展示的原生事件' })
  })
})
