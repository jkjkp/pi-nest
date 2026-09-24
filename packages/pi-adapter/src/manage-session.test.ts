import { beforeEach, describe, expect, it, vi } from 'vitest'

const open = vi.fn()
const create = vi.fn()
const existsSync = vi.fn()
const writeFileSync = vi.fn()
const unlink = vi.fn()
const execFile = vi.fn()
const spawnSync = vi.fn()

vi.mock('@earendil-works/pi-coding-agent', () => ({ SessionManager: { create, open } }))
vi.mock('node:child_process', () => ({ execFile, spawnSync }))
vi.mock('node:fs', () => ({ existsSync, writeFileSync }))
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
    create.mockReset()
    existsSync.mockReset()
    writeFileSync.mockReset()
    unlink.mockReset()
    execFile.mockReset()
    spawnSync.mockReset()
    appendSessionInfo.mockReset()
    open.mockReturnValue({
      appendSessionInfo,
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/session-1.jsonl',
      getSessionId: () => 'session-1',
    })
    create.mockReturnValue({
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/created.jsonl',
      getSessionId: () => 'created-session',
    })
  })

  it('appends a validated native session name', async () => {
    const { renamePiSession } = await import('./index.js')

    renamePiSession({ ...options, name: '  Plan review  ' })

    expect(appendSessionInfo).toHaveBeenCalledWith('Plan review')
  })

  it('creates a session bound to the requested absolute workspace', async () => {
    const { createPiSession } = await import('./index.js')

    expect(createPiSession('/working')).toEqual({ cwd: '/working', id: 'created-session', sessionFile: '/pi/created.jsonl' })
    expect(create).toHaveBeenCalledWith('/working')
    expect(writeFileSync).toHaveBeenCalledWith('/pi/created.jsonl', '{"cwd":"/working"}\n', { flag: 'wx', mode: 0o600 })
    expect(() => createPiSession('relative')).toThrow('Pi workspace path must be absolute')
  })

  it('does not return a session when its header cannot be safely seeded', async () => {
    const cause = new Error('already exists')
    writeFileSync.mockImplementation(() => { throw cause })
    const { createPiSession } = await import('./index.js')

    expect(() => createPiSession('/working')).toThrow('Failed to create Pi session for /working')
    expect(writeFileSync).toHaveBeenCalledWith('/pi/created.jsonl', '{"cwd":"/working"}\n', { flag: 'wx', mode: 0o600 })
  })

  it('normalizes equivalent absolute workspace paths before binding the new session', async () => {
    const { createPiSession } = await import('./index.js')

    createPiSession('/working/../working')

    expect(create).toHaveBeenCalledWith('/working')
  })

  it('reveals an absolute workspace through Finder without deriving a path from UI text', async () => {
    execFile.mockImplementation((_command: string, _args: string[], callback: (error: null, stdout: string, stderr: string) => void) => callback(null, '', ''))
    const { revealPiWorkspace } = await import('./index.js')

    await revealPiWorkspace('/working')
    expect(execFile).toHaveBeenCalledWith('/usr/bin/open', ['-R', '/working'], expect.any(Function))
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
