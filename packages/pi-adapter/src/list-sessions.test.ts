import { beforeEach, describe, expect, it, vi } from 'vitest'

const listAll = vi.fn()

vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: { listAll },
}))

describe('listPiSessions', () => {
  beforeEach(() => {
    listAll.mockReset()
  })

  it('is exported from the package entry point', async () => {
    const entry = await import('./index.js')

    expect(entry.listPiSessions).toBeTypeOf('function')
  })

  it('maps SDK session metadata to the minimal summary', async () => {
    listAll.mockResolvedValue([
      {
        id: 'session-1',
        name: 'Named session',
        firstMessage: 'First question',
        path: '/pi/sessions/session-1.jsonl',
        cwd: '',
        modified: new Date('2026-09-20T08:00:00.000Z'),
      },
    ])

    const { listPiSessions } = await import('./index.js')

    await expect(listPiSessions()).resolves.toEqual([
      {
        id: 'session-1',
        name: 'Named session',
        firstMessage: 'First question',
        sessionFile: '/pi/sessions/session-1.jsonl',
        cwd: undefined,
        updatedAt: '2026-09-20T08:00:00.000Z',
      },
    ])
  })

  it('collapses, trims, and limits the first user message', async () => {
    listAll.mockResolvedValue([
      {
        id: 'session-multiline',
        path: '/pi/sessions/multiline.jsonl',
        cwd: '/work',
        firstMessage: '  fix   the\n\nsidebar   title  ',
        modified: new Date('2026-09-20T08:00:00.000Z'),
      },
      {
        id: 'session-long',
        path: '/pi/sessions/long.jsonl',
        cwd: '/work',
        firstMessage: 'x'.repeat(200),
        modified: new Date('2026-09-20T08:00:00.000Z'),
      },
    ])

    const { listPiSessions } = await import('./index.js')
    const [multiline, long] = await listPiSessions()

    expect(multiline.firstMessage).toBe('fix the sidebar title')
    expect(Array.from(long.firstMessage ?? '')).toHaveLength(121)
    expect(long.firstMessage?.endsWith('…')).toBe(true)
  })

  it('treats empty and placeholder first messages as absent', async () => {
    listAll.mockResolvedValue([
      { id: 'empty', path: '/pi/empty.jsonl', cwd: '/work', firstMessage: '   ', modified: new Date() },
      { id: 'placeholder', path: '/pi/none.jsonl', cwd: '/work', firstMessage: '(no messages)', modified: new Date() },
    ])

    const { listPiSessions } = await import('./index.js')

    await expect(listPiSessions()).resolves.toMatchObject([
      { firstMessage: undefined, id: 'empty' },
      { firstMessage: undefined, id: 'placeholder' },
    ])
  })

  it('adds context while preserving an SDK failure as the cause', async () => {
    const cause = new Error('Pi data is unavailable')
    listAll.mockRejectedValue(cause)
    const { listPiSessions } = await import('./index.js')

    await expect(listPiSessions()).rejects.toMatchObject({
      message: 'Failed to discover Pi sessions with SessionManager.listAll()',
      cause,
    })
  })
})
