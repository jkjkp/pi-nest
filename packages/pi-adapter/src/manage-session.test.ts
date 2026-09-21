import { beforeEach, describe, expect, it, vi } from 'vitest'

const open = vi.fn()
const existsSync = vi.fn()
const unlink = vi.fn()
const spawnSync = vi.fn()

vi.mock('@earendil-works/pi-coding-agent', () => ({ SessionManager: { open } }))
vi.mock('node:child_process', () => ({ spawnSync }))
vi.mock('node:fs', () => ({ existsSync }))
vi.mock('node:fs/promises', () => ({ unlink }))

const options = {
  expectedCwd: '/working',
  expectedSessionId: 'session-1',
  sessionFile: '/pi/session-1.jsonl',
}

describe('Pi session mutations', () => {
  const appendSessionInfo = vi.fn()

  beforeEach(() => {
    open.mockReset()
    existsSync.mockReset()
    unlink.mockReset()
    spawnSync.mockReset()
    appendSessionInfo.mockReset()
    open.mockReturnValue({
      appendSessionInfo,
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/session-1.jsonl',
      getSessionId: () => 'session-1',
    })
  })

  it('appends a validated native session name', async () => {
    const { renamePiSession } = await import('./index.js')

    renamePiSession({ ...options, name: '  Plan review  ' })

    expect(appendSessionInfo).toHaveBeenCalledWith('Plan review')
  })

  it('preserves binding failures as the rename cause', async () => {
    open.mockReturnValue({
      appendSessionInfo,
      getHeader: () => ({ cwd: '/other' }),
      getSessionFile: () => options.sessionFile,
      getSessionId: () => options.expectedSessionId,
    })
    const { renamePiSession } = await import('./index.js')

    expect(() => renamePiSession({ ...options, name: 'Name' })).toThrow('Failed to rename Pi session session-1')
    try {
      renamePiSession({ ...options, name: 'Name' })
    } catch (error) {
      expect(error).toMatchObject({ cause: expect.any(Error) })
    }
    expect(appendSessionInfo).not.toHaveBeenCalled()
  })

  it('uses the system trash before deleting a session file', async () => {
    spawnSync.mockReturnValue({ status: 0 })
    const { deletePiSession } = await import('./index.js')

    await expect(deletePiSession(options)).resolves.toEqual({ method: 'trash' })
    expect(spawnSync).toHaveBeenCalledWith('/usr/bin/trash', [options.sessionFile], { encoding: 'utf8' })
    expect(unlink).not.toHaveBeenCalled()
  })

  it('falls back to permanent unlink when trash fails', async () => {
    spawnSync.mockReturnValue({ status: 1 })
    existsSync.mockReturnValue(true)
    unlink.mockResolvedValue(undefined)
    const { deletePiSession } = await import('./index.js')

    await expect(deletePiSession(options)).resolves.toEqual({ method: 'unlink' })
    expect(unlink).toHaveBeenCalledWith(options.sessionFile)
  })

  it('preserves deletion failures and does not delete an unbound session', async () => {
    open.mockReturnValue({
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/other.jsonl',
      getSessionId: () => options.expectedSessionId,
    })
    const { deletePiSession } = await import('./index.js')

    await expect(deletePiSession(options)).rejects.toMatchObject({
      cause: expect.any(Error),
      message: 'Failed to delete Pi session session-1',
    })
    expect(spawnSync).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
  })

  it('preserves a permanent deletion failure as the cause', async () => {
    const cause = new Error('permission denied')
    spawnSync.mockReturnValue({ status: 1 })
    existsSync.mockReturnValue(true)
    unlink.mockRejectedValue(cause)
    const { deletePiSession } = await import('./index.js')

    await expect(deletePiSession(options)).rejects.toMatchObject({
      cause,
      message: 'Failed to delete Pi session session-1',
    })
  })
})
