import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as projectRegistry from './project-registry.js'
import { selectProjectFolder } from './project-folder-picker.js'

vi.mock('node:child_process', async (original) => {
  const { promisify } = await import('node:util')
  const mocked = vi.fn()
  Object.defineProperty(mocked, promisify.custom, { value: (...args: unknown[]) => new Promise((resolve, reject) => {
    mocked(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))
  }) })
  return { ...await original<typeof import('node:child_process')>(), execFile: mocked }
})
beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  vi.mocked(execFile).mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function output(stdout: string) {
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    ;(callback as (error: Error | null, stdout: string, stderr: string) => void)(null, stdout, '')
    return {} as ReturnType<typeof execFile>
  })
}

it('opens a single-folder native picker using arguments and returns a canonical directory', async () => {
  const directory = realpathSync(tmpdir())
  output(`${directory}\n`)
  await expect(selectProjectFolder(directory)).resolves.toBe(directory)
  expect(execFile).toHaveBeenCalledWith('/usr/bin/osascript', ['-e', expect.stringContaining('without multiple selections allowed'), directory], expect.objectContaining({ timeout: 300_000 }), expect.any(Function))
})

it('treats native cancellation as no selection and rejects files returned by the process', async () => {
  output('\n')
  await expect(selectProjectFolder()).resolves.toBeNull()
  output(`${fileURLToPath(import.meta.url)}\n`)
  await expect(selectProjectFolder()).rejects.toThrow('不是文件夹')
})

it('prevents concurrent windows and releases the lock after errors', async () => {
  let complete!: (error: Error | null, stdout: string, stderr: string) => void
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    complete = callback as typeof complete
    return {} as ReturnType<typeof execFile>
  })
  const first = selectProjectFolder()
  await expect(selectProjectFolder()).rejects.toThrow('已有文件夹选择窗口')
  complete(new Error('process failed'), '', '')
  await expect(first).rejects.toThrow('process failed')
  output('\n')
  await expect(selectProjectFolder()).resolves.toBeNull()
})

it('reports unsupported hosts without invoking an OS command', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  await expect(selectProjectFolder()).rejects.toThrow('仅支持 macOS')
  expect(execFile).not.toHaveBeenCalled()
})


it('falls back to the home directory when the previous folder no longer exists', async () => {
  output('\n')
  await expect(selectProjectFolder('/missing/pi-nest-folder')).resolves.toBeNull()
  expect(execFile).toHaveBeenCalledOnce()
})


it.each(['D:\\中文 project & $test', '\\\\server\\share\\项目 folder'])('opens the Windows picker with a safe initial path and validates the result (%s)', async (directory) => {
  vi.stubGlobal('process', { ...process, platform: 'win32', env: { ...process.env, SystemRoot: 'C:\\Windows' } })
  const validate = vi.spyOn(projectRegistry, 'resolveProjectDirectory').mockImplementation((path) => path)
  output(`${directory}\r\n`)
  await expect(selectProjectFolder(directory)).resolves.toBe(directory)
  expect(execFile).toHaveBeenCalledWith('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', expect.any(String)],
    expect.objectContaining({ encoding: 'utf8', timeout: 300_000, shell: false, windowsHide: true, env: expect.objectContaining({ PI_NEST_PICKER_START: directory }) }), expect.any(Function))
  const args = vi.mocked(execFile).mock.calls[0]![1] as string[]
  const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
  expect(script).toContain('System.Windows.Forms.FolderBrowserDialog')
  expect(script).toContain('$env:PI_NEST_PICKER_START')
  expect(script).toContain('[System.Text.UTF8Encoding]::new($false)')
  expect(script).toContain('$dialog.Dispose()')
  expect(script).not.toContain(directory)
  expect(validate).toHaveBeenLastCalledWith(directory)
})

it('handles Windows cancellation, validation errors and launch failure without leaving the picker locked', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const validate = vi.spyOn(projectRegistry, 'resolveProjectDirectory').mockImplementation((path) => {
    if (path === 'D:\\invalid') throw new Error('该路径不是文件夹。')
    return path
  })
  output('')
  await expect(selectProjectFolder()).resolves.toBeNull()
  output('D:\\invalid')
  await expect(selectProjectFolder()).rejects.toThrow('不是文件夹')
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    ;(callback as (error: Error) => void)(Object.assign(new Error('PowerShell unavailable'), { code: 'ENOENT' }))
    return {} as ReturnType<typeof execFile>
  })
  await expect(selectProjectFolder()).rejects.toMatchObject({ code: 'ENOENT' })
  output('D:\\valid')
  await expect(selectProjectFolder()).resolves.toBe('D:\\valid')
  expect(validate).toHaveBeenLastCalledWith('D:\\valid')
})
