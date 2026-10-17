import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
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
afterEach(() => vi.unstubAllGlobals())

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
  output('/etc/hosts\n')
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
