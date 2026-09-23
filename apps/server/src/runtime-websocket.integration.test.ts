import { once } from 'node:events'

import { serve } from '@hono/node-server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { createApp } from './app.js'
import type { PiRuntimeRegistry } from './pi-runtime-registry.js'
import { RuntimeSecurity } from './runtime-security.js'

const adapter = vi.hoisted(() => ({ listPiSessions: vi.fn() }))
vi.mock('@pi-nest/pi-adapter', () => adapter)

const servers: Array<ReturnType<typeof serve>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function runtime() {
  return {
    abort: vi.fn(), beginMutation: vi.fn(), isPromptActive: vi.fn(), startPrompt: vi.fn(), unwatch: vi.fn(), watch: vi.fn(() => () => undefined),
  }
}

async function start(security: RuntimeSecurity) {
  const websocket = new WebSocketServer({ noServer: true })
  const server = serve({ fetch: createApp(runtime() as never as PiRuntimeRegistry, security).fetch, hostname: '127.0.0.1', port: 0, websocket: { server: websocket } })
  servers.push(server)
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port')
  return `http://127.0.0.1:${address.port}`
}

function connect(url: string, origin: string) {
  const socket = new WebSocket(url, { origin })
  return new Promise<WebSocket>((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
    socket.once('unexpected-response', (_request, response) => reject(new Error(`Unexpected response: ${response.statusCode}`)))
  })
}

describe('runtime WebSocket upgrade', () => {
  it('accepts a valid origin and startup token, then rejects other origins or tokens before upgrade', async () => {
    adapter.listPiSessions.mockResolvedValue([{ cwd: '/fixture', id: 'session-1', sessionFile: '/fixture/session.jsonl' }])
    const security = new RuntimeSecurity('http://localhost:5173')
    const base = await start(security)
    const bootstrap = await fetch(`${base}/api/runtime/bootstrap`, { method: 'POST', headers: { origin: security.origin } })
    const { token } = await bootstrap.json() as { token: string }
    const socket = await connect(`${base.replace('http', 'ws')}/api/runtime?token=${encodeURIComponent(token)}`, security.origin)
    socket.send(JSON.stringify({ id: 'watch-1', sessionId: 'session-1', type: 'watch' }))
    const [message] = await once(socket, 'message')
    expect(JSON.parse(message.toString())).toEqual({ command: 'watch', id: 'watch-1', sessionId: 'session-1', type: 'ack' })
    socket.close()

    await expect(connect(`${base.replace('http', 'ws')}/api/runtime?token=wrong`, security.origin)).rejects.toThrow()
    await expect(connect(`${base.replace('http', 'ws')}/api/runtime?token=${encodeURIComponent(token)}`, 'http://127.0.0.1:5173')).rejects.toThrow()
  })
})
