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
        path: '/pi/sessions/session-1.jsonl',
        cwd: '',
        modified: new Date('2026-09-20T08:00:00.000Z'),
      },
    ])

    const { listPiSessions } = await import('./index.js')

    await expect(listPiSessions()).resolves.toEqual([
      {
        id: 'session-1',
        sessionFile: '/pi/sessions/session-1.jsonl',
        cwd: undefined,
        updatedAt: '2026-09-20T08:00:00.000Z',
      },
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
