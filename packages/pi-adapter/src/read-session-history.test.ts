import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const open = vi.fn()

vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: { open },
}))

let fixtureDirectory: string
let sourceSessionFile: string

function session(entries: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    buildContextEntries: () => entries,
    getHeader: () => ({ cwd: '/working' }),
    getSessionFile: () => open.mock.calls.at(-1)?.[0],
    getSessionId: () => 'session-1',
    ...overrides,
  }
}

function user(id: string, timestamp: string, content: unknown) {
  return { id, message: { content, role: 'user' }, parentId: null, timestamp, type: 'message' }
}

describe('readPiSessionHistory', () => {
  beforeEach(() => {
    open.mockReset()
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'pi-nest-history-test-'))
    sourceSessionFile = join(fixtureDirectory, 'source.jsonl')
    writeFileSync(sourceSessionFile, '{"type":"session"}\n')
  })

  afterEach(() => {
    rmSync(fixtureDirectory, { force: true, recursive: true })
  })

  it('is exported and preserves every current-branch entry without changing the source', async () => {
    open.mockReturnValue(
      session([
        user('user-1', '2026-09-21T00:00:00.000Z', 'Hello'),
        {
          id: 'assistant-1',
          message: {
            content: [
              { text: 'Hello back', type: 'text' },
              { thinking: 'hidden', type: 'thinking' },
            ],
            role: 'assistant',
            stopReason: 'aborted',
          },
          parentId: 'user-1',
          timestamp: '2026-09-21T00:00:01.000Z',
          type: 'message',
        },
        {
          id: 'tool-1',
          message: { content: [{ text: 'hidden tool output', type: 'text' }], role: 'toolResult' },
          parentId: 'assistant-1',
          timestamp: '2026-09-21T00:00:02.000Z',
          type: 'message',
        },
        {
          id: 'model-1',
          modelId: 'hidden-model',
          parentId: 'tool-1',
          provider: 'hidden-provider',
          timestamp: '2026-09-21T00:00:03.000Z',
          type: 'model_change',
        },
      ]),
    )
    const sourceBefore = readFileSync(sourceSessionFile)
    const entry = await import('./index.js')

    expect(entry.readPiSessionHistory({
      expectedCwd: '/working',
      expectedSessionId: 'session-1',
      sessionFile: sourceSessionFile,
    })).toMatchObject({
      hasEarlier: false,
      revision: expect.any(String),
      entries: [
        {
          id: 'user-1',
          parentId: null,
          raw: user('user-1', '2026-09-21T00:00:00.000Z', 'Hello'),
          timestamp: '2026-09-21T00:00:00.000Z',
          type: 'message',
        },
        {
          id: 'assistant-1',
          parentId: 'user-1',
          raw: {
            id: 'assistant-1',
            message: {
              content: [{ text: 'Hello back', type: 'text' }, { thinking: 'hidden', type: 'thinking' }],
              role: 'assistant',
              stopReason: 'aborted',
            },
            parentId: 'user-1',
            timestamp: '2026-09-21T00:00:01.000Z',
            type: 'message',
          },
          timestamp: '2026-09-21T00:00:01.000Z',
          type: 'message',
        },
        {
          id: 'tool-1',
          parentId: 'assistant-1',
          raw: {
            id: 'tool-1',
            message: { content: [{ text: 'hidden tool output', type: 'text' }], role: 'toolResult' },
            parentId: 'assistant-1',
            timestamp: '2026-09-21T00:00:02.000Z',
            type: 'message',
          },
          timestamp: '2026-09-21T00:00:02.000Z',
          type: 'message',
        },
        {
          id: 'model-1',
          parentId: 'tool-1',
          raw: {
            id: 'model-1', modelId: 'hidden-model', parentId: 'tool-1', provider: 'hidden-provider', timestamp: '2026-09-21T00:00:03.000Z', type: 'model_change',
          },
          timestamp: '2026-09-21T00:00:03.000Z',
          type: 'model_change',
        },
      ],
    })
    expect(readFileSync(sourceSessionFile)).toEqual(sourceBefore)

    const copiedSessionFile = open.mock.calls[0][0] as string
    expect(copiedSessionFile).not.toBe(sourceSessionFile)
    expect(existsSync(dirname(copiedSessionFile))).toBe(false)
  })

  it('keeps more than 200 Turns fully accessible through stable Turn-start cursors', async () => {
    open.mockReturnValue(
      session(
        Array.from({ length: 1_000 }, (_, index) =>
          user(`user-${index}`, `2026-09-21T00:00:${String(index).padStart(2, '0')}.000Z`, `Message ${index}`),
        ),
      ),
    )
    const { readPiSessionHistory } = await import('./read-session-history.js')

    const first = readPiSessionHistory({ expectedSessionId: 'session-1', sessionFile: sourceSessionFile })
    const second = readPiSessionHistory({ before: first.beforeCursor, expectedSessionId: 'session-1', sessionFile: sourceSessionFile })
    const loaded = [...first.entries, ...second.entries]
    let page = second
    while (page.hasEarlier) {
      page = readPiSessionHistory({ before: page.beforeCursor, expectedSessionId: 'session-1', sessionFile: sourceSessionFile })
      loaded.push(...page.entries)
    }

    expect(first.entries).toHaveLength(40)
    expect(first.entries[0]).toMatchObject({ id: 'user-960', type: 'message' })
    expect(first.beforeCursor).toBe('user-960')
    expect(second.entries.map((entry) => entry.id)).toEqual(Array.from({ length: 40 }, (_, index) => `user-${920 + index}`))
    expect(new Set(loaded.map((entry) => entry.id)).size).toBe(1_000)
    expect(page.hasEarlier).toBe(false)
  })

  it('never splits a Turn when selecting a page', async () => {
    open.mockReturnValue(session([
      user('user-1', '2026-09-21T00:00:00.000Z', 'one'),
      { id: 'assistant-1', message: { content: 'one', role: 'assistant' }, parentId: 'user-1', timestamp: '2026-09-21T00:00:01.000Z', type: 'message' },
      { id: 'tool-1', message: { content: [], role: 'toolResult' }, parentId: 'assistant-1', timestamp: '2026-09-21T00:00:02.000Z', type: 'message' },
      user('user-2', '2026-09-21T00:00:03.000Z', 'two'),
      { id: 'assistant-2', message: { content: 'two', role: 'assistant' }, parentId: 'user-2', timestamp: '2026-09-21T00:00:04.000Z', type: 'message' },
      user('user-3', '2026-09-21T00:00:05.000Z', 'three'),
      { id: 'assistant-3', message: { content: 'three', role: 'assistant' }, parentId: 'user-3', timestamp: '2026-09-21T00:00:06.000Z', type: 'message' },
    ]))
    const { readPiSessionHistory } = await import('./read-session-history.js')

    const latest = readPiSessionHistory({ expectedSessionId: 'session-1', limit: 1, sessionFile: sourceSessionFile })
    const previous = readPiSessionHistory({ before: latest.beforeCursor, expectedSessionId: 'session-1', limit: 1, sessionFile: sourceSessionFile })

    expect(latest.entries.map((entry) => entry.id)).toEqual(['user-3', 'assistant-3'])
    expect(previous.entries.map((entry) => entry.id)).toEqual(['user-2', 'assistant-2'])
    expect(previous.hasEarlier).toBe(true)
  })

  it('builds a lightweight complete Turn index without returning Turn bodies', async () => {
    open.mockReturnValue(session([
      user('user-1', '2026-09-21T00:00:00.000Z', ' first\n prompt '),
      { id: 'assistant-1', message: { content: 'answer', role: 'assistant' }, parentId: 'user-1', timestamp: '2026-09-21T00:00:01.000Z', type: 'message' },
      user('user-2', '2026-09-21T00:00:02.000Z', [{ text: 'second prompt', type: 'text' }]),
    ]))
    const { readPiSessionTurnIndex } = await import('./read-session-history.js')

    expect(readPiSessionTurnIndex({ expectedSessionId: 'session-1', sessionFile: sourceSessionFile })).toMatchObject({
      revision: expect.any(String),
      entries: [
        { id: 'user-1', index: 1, promptPreview: 'first prompt', startedAt: '2026-09-21T00:00:00.000Z' },
        { id: 'user-2', index: 2, promptPreview: 'second prompt', startedAt: '2026-09-21T00:00:02.000Z' },
      ],
    })
  })

  it('rejects a page or index request from a different source revision', async () => {
    open.mockReturnValue(session([]))
    const { PiSessionHistoryRevisionError, readPiSessionHistory, readPiSessionTurnIndex } = await import('./read-session-history.js')

    expect(() => readPiSessionHistory({ expectedSessionId: 'session-1', revision: '0'.repeat(64), sessionFile: sourceSessionFile })).toThrow(PiSessionHistoryRevisionError)
    expect(() => readPiSessionTurnIndex({ expectedSessionId: 'session-1', revision: '0'.repeat(64), sessionFile: sourceSessionFile })).toThrow(PiSessionHistoryRevisionError)
  })

  it('fails safely when SDK binding validation fails and cleans the temporary copy', async () => {
    open.mockReturnValue(session([], { getSessionId: () => 'other-session' }))
    const { readPiSessionHistory } = await import('./read-session-history.js')

    await expect(() => readPiSessionHistory({
      expectedSessionId: 'session-1',
      sessionFile: sourceSessionFile,
    })).toThrow('Failed to read Pi session history')

    const copiedSessionFile = open.mock.calls[0][0] as string
    expect(existsSync(dirname(copiedSessionFile))).toBe(false)
  })

  it('reports source changes without returning a history', async () => {
    open.mockImplementation(() => {
      writeFileSync(sourceSessionFile, '{"type":"session","changed":true}\n')
      return session([])
    })
    const { PiSessionHistorySourceChangedError, readPiSessionHistory } = await import('./read-session-history.js')

    expect(() => readPiSessionHistory({
      expectedSessionId: 'session-1',
      sessionFile: sourceSessionFile,
    })).toThrow(PiSessionHistorySourceChangedError)
  })

  it('preserves the SDK cause', async () => {
    const cause = new Error('SDK failed')
    open.mockImplementation(() => {
      throw cause
    })
    const { readPiSessionHistory } = await import('./read-session-history.js')

    try {
      readPiSessionHistory({ expectedSessionId: 'session-1', sessionFile: sourceSessionFile })
    } catch (error) {
      expect(error).toMatchObject({ cause })
    }
  })
})
