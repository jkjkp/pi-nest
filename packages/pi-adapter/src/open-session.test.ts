import { beforeEach, describe, expect, it, vi } from 'vitest'

const open = vi.fn()

vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: { open },
}))

describe('openPiSession', () => {
  beforeEach(() => {
    open.mockReset()
  })

  it('is exported from the package entry point', async () => {
    const entry = await import('./index.js')

    expect(entry.openPiSession).toBeTypeOf('function')
  })

  it('opens a session and returns only its structural summary', async () => {
    open.mockReturnValue({
      getSessionId: () => 'session-1',
      getSessionFile: () => '/pi/sessions/session-1.jsonl',
      getHeader: () => ({ cwd: '/project' }),
      getEntries: () => [
        { type: 'message', message: { content: 'do not expose this' } },
        { type: 'label' },
        { type: 'message', message: { content: 'or this' } },
      ],
      getLeafId: () => 'entry-2',
    })
    const { openPiSession } = await import('./index.js')

    expect(openPiSession('/pi/sessions/session-1.jsonl')).toEqual({
      id: 'session-1',
      sessionFile: '/pi/sessions/session-1.jsonl',
      cwd: '/project',
      messageCount: 2,
      leafId: 'entry-2',
    })
    expect(open).toHaveBeenCalledWith('/pi/sessions/session-1.jsonl')
  })

  it('adds context while preserving an SDK failure as the cause', async () => {
    const cause = new Error('Pi session is unavailable')
    open.mockImplementation(() => {
      throw cause
    })
    const { openPiSession } = await import('./index.js')

    expect(() => openPiSession('/pi/sessions/session-1.jsonl')).toThrow(
      'Failed to open Pi session: /pi/sessions/session-1.jsonl',
    )

    try {
      openPiSession('/pi/sessions/session-1.jsonl')
    } catch (error) {
      expect(error).toMatchObject({ cause })
    }
  })
})
