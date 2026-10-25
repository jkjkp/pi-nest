import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const open = vi.fn()
const create = vi.fn()
const existsSync = vi.fn()
const writeFileSync = vi.fn()
const unlink = vi.fn()
const execFile = vi.fn()
const spawnSync = vi.fn()
const spawn = vi.fn()
const stat = vi.fn()
const access = vi.fn()

vi.mock('@earendil-works/pi-coding-agent', () => ({ SessionManager: { create, open } }))
vi.mock('node:child_process', () => ({ execFile, spawn, spawnSync }))
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync, writeFileSync }))
vi.mock('node:fs/promises', () => ({ access, stat, unlink }))

const options = {
  expectedCwd: '/working',
  expectedSessionId: 'session-1',
  sessionFile: '/pi/session-1.jsonl',
}

describe('Pi session mutations', () => {
  const appendSessionInfo = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    open.mockReset()
    create.mockReset()
    existsSync.mockReset()
    writeFileSync.mockReset()
    unlink.mockReset()
    execFile.mockReset()
    spawnSync.mockReset()
    spawn.mockReset()
    stat.mockReset().mockResolvedValue({ isDirectory: () => true })
    access.mockReset().mockResolvedValue(undefined)
    appendSessionInfo.mockReset()
    open.mockReturnValue({
      appendSessionInfo,
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/session-1.jsonl',
      getSessionId: () => 'session-1',
    })
    create.mockReturnValue({
      getHeader: () => ({ cwd: '/working', timestamp: '2026-10-13T00:00:00.000Z' }),
      getSessionFile: () => '/pi/created.jsonl',
      getSessionId: () => 'created-session',
    })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('appends a validated native session name', async () => {
    const { renamePiSession } = await import('./index.js')

    renamePiSession({ ...options, name: '  Plan review  ' })

    expect(appendSessionInfo).toHaveBeenCalledWith('Plan review')
  })

  it('creates a session bound to the requested absolute workspace', async () => {
    const { createPiSession } = await import('./index.js')

    expect(createPiSession('/working')).toEqual({ createdAt: '2026-10-13T00:00:00.000Z', cwd: '/working', id: 'created-session', sessionFile: '/pi/created.jsonl' })
    expect(create).toHaveBeenCalledWith('/working')
    expect(writeFileSync).toHaveBeenCalledWith('/pi/created.jsonl', '{"cwd":"/working","timestamp":"2026-10-13T00:00:00.000Z"}\n', { flag: 'wx', mode: 0o600 })
    expect(() => createPiSession('relative')).toThrow('Pi workspace path must be absolute')
  })

  it('does not return a session when its header cannot be safely seeded', async () => {
    const cause = new Error('already exists')
    writeFileSync.mockImplementation(() => { throw cause })
    const { createPiSession } = await import('./index.js')

    expect(() => createPiSession('/working')).toThrow('Failed to create Pi session for /working')
    expect(writeFileSync).toHaveBeenCalledWith('/pi/created.jsonl', '{"cwd":"/working","timestamp":"2026-10-13T00:00:00.000Z"}\n', { flag: 'wx', mode: 0o600 })
  })

  it('normalizes equivalent absolute workspace paths before binding the new session', async () => {
    const { createPiSession } = await import('./index.js')

    createPiSession('/working/../working')

    expect(create).toHaveBeenCalledWith('/working')
  })

  it.each([['darwin', '/usr/bin/open'], ['linux', 'xdg-open']])('opens a folder on %s without invoking a shell', async (platform, command) => {
    vi.stubGlobal('process', { ...process, platform })
    execFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => callback(null, '', ''))
    const { revealPiWorkspace } = await import('./index.js')

    const cwd = '/working/中文 project & $(test)'
    await revealPiWorkspace(cwd)
    expect(stat).toHaveBeenCalledWith(cwd)
    expect(access).toHaveBeenCalledWith(cwd, 5)
    expect(execFile).toHaveBeenCalledWith(command, [cwd], { timeout: 10_000, shell: false }, expect.any(Function))
  })

  it.each(['C:\\工作 project & test', '\\\\server\\share\\项目 folder'])('opens %s with Windows Explorer and does not wait for its handoff exit code', async (cwd) => {
    vi.stubGlobal('process', { ...process, platform: 'win32', env: { ...process.env, SystemRoot: 'D:\\Windows' } })
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    spawn.mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    const { revealPiWorkspace } = await import('./index.js')
    await revealPiWorkspace(cwd)
    expect(spawn).toHaveBeenCalledWith('D:\\Windows\\explorer.exe', [cwd], { shell: false, windowsHide: false, detached: true, stdio: 'ignore' })
    expect(child.unref).toHaveBeenCalledOnce()
    expect(access).toHaveBeenCalledWith(cwd, 4)
    child.emit('exit', 1, null)
    expect(console.info).toHaveBeenCalledWith('Windows Explorer exited; window visibility is unknown', { executable: 'D:\\Windows\\explorer.exe', code: 1, signal: null })
    expect(execFile).not.toHaveBeenCalled()
  })

  it.each([
    ['ENOENT', 'PROJECT_FOLDER_UNAVAILABLE'], ['ENOTDIR', 'PROJECT_FOLDER_UNAVAILABLE'],
    ['EACCES', 'PROJECT_FOLDER_ACCESS_DENIED'], ['EPERM', 'PROJECT_FOLDER_ACCESS_DENIED'],
  ])('rejects inaccessible folders (%s) before launching the file manager', async (code, expected) => {
    stat.mockRejectedValueOnce(Object.assign(new Error('filesystem error'), { code }))
    const { revealPiWorkspace } = await import('./index.js')
    await expect(revealPiWorkspace('/working')).rejects.toMatchObject({ code: expected, cause: { code } })
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects files, relative paths, access failures and unsupported platforms', async () => {
    const { revealPiWorkspace } = await import('./index.js')
    await expect(revealPiWorkspace('relative')).rejects.toThrow('must be absolute')
    expect(stat).not.toHaveBeenCalled()
    stat.mockResolvedValueOnce({ isDirectory: () => false })
    await expect(revealPiWorkspace('/working')).rejects.toMatchObject({ code: 'PROJECT_FOLDER_UNAVAILABLE' })
    access.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(revealPiWorkspace('/working')).rejects.toMatchObject({ code: 'PROJECT_FOLDER_ACCESS_DENIED' })
    vi.stubGlobal('process', { ...process, platform: 'freebsd' })
    await expect(revealPiWorkspace('/working')).rejects.toMatchObject({ code: 'PROJECT_FOLDER_UNSUPPORTED' })
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux', 'win32'])('reports file manager launch failures on %s', async (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    const cause = Object.assign(new Error('launcher missing'), { code: 'ENOENT' })
    execFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error) => void) => callback(cause))
    spawn.mockImplementation(() => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('error', cause))
      return child
    })
    const { revealPiWorkspace } = await import('./index.js')
    await expect(revealPiWorkspace(platform === 'win32' ? 'C:\\working' : '/working')).rejects.toMatchObject({ code: 'PROJECT_FOLDER_OPEN_FAILED', cause })
    expect(console.error).toHaveBeenCalledWith('Failed to launch system file manager', expect.objectContaining({ platform, code: 'ENOENT', message: 'launcher missing', executable: expect.any(String), cause }))
  })


  it('logs Windows Explorer errors after handoff without retrying the open request', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    spawn.mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    const { revealPiWorkspace } = await import('./index.js')
    await revealPiWorkspace('D:\\project')
    const cause = Object.assign(new Error('late failure'), { code: 'EPERM', errno: -1, syscall: 'kill' })
    child.emit('error', cause)
    expect(console.error).toHaveBeenCalledWith('Windows Explorer error after launch', expect.objectContaining({ platform: 'win32', executable: expect.any(String), cause }))
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('logs synchronous Windows launch errors with the original system details', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const cause = Object.assign(new Error('blocked'), { code: 'EACCES', errno: -4092, syscall: 'spawn' })
    spawn.mockImplementation(() => { throw cause })
    const { revealPiWorkspace } = await import('./index.js')
    await expect(revealPiWorkspace('D:\\project')).rejects.toMatchObject({ code: 'PROJECT_FOLDER_OPEN_FAILED', cause })
    expect(console.error).toHaveBeenCalledWith('Failed to launch system file manager', expect.objectContaining({ platform: 'win32', code: 'EACCES', errno: -4092, syscall: 'spawn', message: 'blocked', cause }))
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
