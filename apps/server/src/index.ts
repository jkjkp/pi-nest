import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'

import { app, runtime } from './app.js'

const hostname = '127.0.0.1'
const port = 31415

const websocket = new WebSocketServer({ noServer: true })

const server = serve({ fetch: app.fetch, hostname, port, websocket: { server: websocket } }, ({ address, port: boundPort }) => {
  console.log(`Pi Nest server listening on http://${address}:${boundPort}`)
})

function shutdown() {
  server.close(() => { void runtime.close().finally(() => process.exit(0)) })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
