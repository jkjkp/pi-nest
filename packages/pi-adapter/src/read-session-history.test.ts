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

  it('is exported and maps only safe current-branch content without changing the source', async () => {
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
    })).toEqual({
      entries: [
        {
          id: 'user-1',
          kind: 'message',
          role: 'user',
          text: 'Hello',
          timestamp: '2026-09-21T00:00:00.000Z',
        },
        {
          hasOmittedContent: true,
          id: 'assistant-1',
          kind: 'message',
          role: 'assistant',
          stopReason: 'aborted',
          text: 'Hello back',
          timestamp: '2026-09-21T00:00:01.000Z',
        },
        {
          count: 2,
          kind: 'omitted',
          label: '未展示的原生事件',
          timestamp: '2026-09-21T00:00:02.000Z',
        },
      ],
      hasEarlier: false,
    })
    expect(readFileSync(sourceSessionFile)).toEqual(sourceBefore)

    const copiedSessionFile = open.mock.calls[0][0] as string
    expect(copiedSessionFile).not.toBe(sourceSessionFile)
    expect(existsSync(dirname(copiedSessionFile))).toBe(false)
  })

  it('uses the latest 200 SDK context entries', async () => {
    open.mockReturnValue(
      session(
        Array.from({ length: 201 }, (_, index) =>
          user(`user-${index}`, `2026-09-21T00:00:${String(index).padStart(2, '0')}.000Z`, `Message ${index}`),
        ),
      ),
    )
    const { readPiSessionHistory } = await import('./read-session-history.js')

    const history = readPiSessionHistory({ expectedSessionId: 'session-1', sessionFile: sourceSessionFile })

    expect(history.hasEarlier).toBe(true)
    expect(history.entries).toHaveLength(200)
    expect(history.entries[0]).toMatchObject({ id: 'user-1', kind: 'message' })
    expect(history.entries.at(-1)).toMatchObject({ id: 'user-200', kind: 'message' })
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
