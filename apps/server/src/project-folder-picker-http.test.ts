import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { getRequestListener } from '@hono/node-server'
import { createProjectRoutes } from './project-routes.js'
import { ProjectRegistry } from './project-registry.js'
import { RuntimeSecurity } from './runtime-security.js'

const pickerProcesses = vi.hoisted(() => ({ children: [] as import('node:child_process').ChildProcess[], ready: false }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execute = promisify(actual.execFile)
  const mock = vi.fn()
  Object.defineProperty(mock, promisify.custom, { value: (_file: string, _args: string[], options: object) => {
    const script = pickerProcesses.children.length === 0
      ? 'process.stdout.write("ready"); setInterval(() => {}, 1000)'
      : 'process.stdout.write(require("node:os").tmpdir())'
    const pending = execute(process.execPath, ['-e', script], options)
    pickerProcesses.children.push(pending.child)
    pending.child.stdout!.once('data', () => { pickerProcesses.ready = true })
    return pending
  } })
  return { ...actual, execFile: mock }
})

let server: Server | undefined
afterEach(async () => {
  for (const child of pickerProcesses.children) {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed }
  }
  server?.closeAllConnections()
  await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve() })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('propagates a real HTTP disconnect to the picker process and allows another selection after close', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  const security = new RuntimeSecurity('http://localhost:31415')
  const app = new Hono().route('/api/projects', createProjectRoutes(new ProjectRegistry(), security))
  server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/api/projects/select-folder`
  const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/json' }
  const controller = new AbortController()
  const pending = fetch(url, { method: 'POST', headers, body: '{}', signal: controller.signal })
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(pickerProcesses.ready).toBe(true))
  const child = pickerProcesses.children[0]!
  const closed = once(child, 'close')
  controller.abort()
  await rejection
  await closed
  expect(child.signalCode).toBe('SIGTERM')
  const retried = await fetch(url, { method: 'POST', headers, body: '{}' })
  expect(retried.status).toBe(200)
  expect(await retried.json()).toEqual({ cwd: realpathSync(tmpdir()) })
  expect(pickerProcesses.children).toHaveLength(2)
})
