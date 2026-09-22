import { upgradeWebSocket } from '@hono/node-server'
import { Hono } from 'hono'

import { PiRuntimeRegistry } from './pi-runtime-registry.js'
import { RuntimeSecurity } from './runtime-security.js'
import { RuntimeWebSocketBroker } from './runtime-websocket.js'

export function createRuntimeRoutes(runtime: PiRuntimeRegistry, security: RuntimeSecurity) {
  const broker = new RuntimeWebSocketBroker(runtime)
  const upgrade = upgradeWebSocket(() => ({
    onClose: (_event, socket) => broker.close(socket),
    onMessage: (event, socket) => { void broker.message(socket, event.data) },
    onOpen: (_event, socket) => broker.open(socket),
  }))

  return new Hono()
    .post('/runtime/bootstrap', (context) => {
      if (!security.acceptsOrigin(context.req.header('origin'))) return context.json({ error: 'Invalid runtime origin' }, 403)
      return context.json({ runtimeId: security.runtimeId, token: security.token, websocketPath: '/api/runtime' })
    })
    .get('/runtime', async (context, next) => {
      if (!security.acceptsOrigin(context.req.header('origin'))) return context.json({ error: 'Invalid runtime origin' }, 403)
      const token = new URL(context.req.url).searchParams.get('token') ?? undefined
      if (!security.acceptsToken(token)) return context.json({ error: 'Invalid runtime token' }, 403)
      return upgrade(context, next)
    })
}
