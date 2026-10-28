import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let openProjectFolder: typeof import('./workspace-api.js')['openProjectFolder']
beforeEach(async () => { vi.resetModules(); ({ openProjectFolder } = await import('./workspace-api.js')) })

afterEach(() => vi.unstubAllGlobals())

it('consumes the folder-open acknowledgement through the existing authenticated JSON request', async () => {
  const response = Response.json({ requested: true })
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' })).mockResolvedValueOnce(response)
  vi.stubGlobal('fetch', fetcher)
  const cwd = 'D:\\myFiles\\graduationThesisDesign'
  await expect(openProjectFolder(cwd)).resolves.toBeUndefined()
  expect(response.bodyUsed).toBe(true)
  expect(fetcher).toHaveBeenLastCalledWith('/api/projects/reveal', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ cwd }),
    headers: expect.any(Headers),
  }))
  expect(fetcher.mock.calls.at(-1)![1].headers.get('x-pi-nest-token')).toBe('token')
})

it('preserves the launcher error code and message on failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' })).mockResolvedValueOnce(Response.json({
    code: 'PROJECT_FOLDER_OPEN_FAILED', error: '无法启动系统文件管理器，请确认当前系统支持桌面操作。',
  }, { status: 500 })))
  await expect(openProjectFolder('D:\\project')).rejects.toMatchObject({
    code: 'PROJECT_FOLDER_OPEN_FAILED', message: '无法启动系统文件管理器，请确认当前系统支持桌面操作。',
  })
})
