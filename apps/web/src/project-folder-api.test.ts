import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let openProjectFolder: typeof import('./workspace-api.js')['openProjectFolder']
let selectProjectFolder: typeof import('./workspace-api.js')['selectProjectFolder']
beforeEach(async () => { vi.resetModules(); ({ openProjectFolder, selectProjectFolder } = await import('./workspace-api.js')) })

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

it('passes picker cancellation through the authenticated request to fetch', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ runtimeId: 'runtime-1', token: 'token', websocketPath: '/api/runtime' }))
    .mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new AbortController()
  const selection = selectProjectFolder('D:\\project', controller.signal)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  const rejection = expect(selection).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejection
  expect(fetcher).toHaveBeenLastCalledWith('/api/projects/select-folder', expect.objectContaining({ signal: controller.signal, body: JSON.stringify({ cwd: 'D:\\project' }) }))
})
