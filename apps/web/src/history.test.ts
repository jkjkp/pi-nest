import { describe, expect, it } from 'vitest'

import { historyPageCursorForTurn, historyUserTurnCount, mergeSessionHistoryPages, sessionHistoryQueryKey, sessionTurnIndexQueryKey, type PiSessionHistoryResponse } from './history.js'

describe('session history presentation contract', () => {
  it('keeps history cache isolated by session ID', () => {
    expect(sessionHistoryQueryKey('first')).toEqual(['session-history', 'first'])
    expect(sessionHistoryQueryKey('second')).not.toEqual(sessionHistoryQueryKey('first'))
    expect(sessionTurnIndexQueryKey('first')).toEqual(['session-turn-index', 'first'])
  })

  it('uses the following stable Turn ID to load a page containing an unloaded Turn', () => {
    const entries = ['turn-1', 'turn-2', 'turn-3'].map((id, index) => ({ id, index: index + 1, promptPreview: id, startedAt: 'now' }))
    expect(historyPageCursorForTurn(entries, 'turn-1')).toBe('turn-2')
    expect(historyPageCursorForTurn(entries, 'turn-3')).toBeUndefined()
    expect(historyPageCursorForTurn(entries, 'missing')).toBeUndefined()
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

  it('counts only persisted user messages as conversation turns', () => {
    expect(historyUserTurnCount([
      { id: 'user', parentId: null, raw: { message: { role: 'user' }, type: 'message' }, timestamp: 'now', type: 'message' },
      { id: 'assistant', parentId: 'user', raw: { message: { role: 'assistant' }, type: 'message' }, timestamp: 'now', type: 'message' },
      { id: 'tool', parentId: 'user', raw: { type: 'tool_execution_start' }, timestamp: 'now', type: 'tool_execution_start' },
    ])).toBe(1)
  })

  it('merges earlier pages before the latest page without changing their order', () => {
    const session = { cwd: '/safe/project', id: 'session-1', updatedAt: '2026-09-21T00:00:00.000Z' }
    const history = mergeSessionHistoryPages([
      { entries: [{ id: 'user-1', parentId: null, raw: {}, timestamp: 'one', type: 'message' }], hasEarlier: false, session },
      { beforeCursor: 'user-2', entries: [{ id: 'user-2', parentId: 'user-1', raw: {}, timestamp: 'two', type: 'message' }], hasEarlier: true, session },
    ])

    expect(history?.entries.map((entry) => entry.id)).toEqual(['user-1', 'user-2'])
    expect(history?.hasEarlier).toBe(true)
  })
})
