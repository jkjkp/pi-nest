import { serve } from '@hono/node-server'

import { app } from './app.js'

const hostname = '127.0.0.1'
const port = 31415

serve({ fetch: app.fetch, hostname, port }, ({ address, port: boundPort }) => {
  console.log(`Pi Nest server listening on http://${address}:${boundPort}`)
})
