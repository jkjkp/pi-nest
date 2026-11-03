import { homedir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceDatabase } from './workspace-database.js'
import { SessionBranchStore } from './session-branch-store.js'
import { SessionBranchService } from './session-branch-service.js'
import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'

import { createApp, runtime, runtimeSecurity, sessionIndex } from './app.js'

const database = new WorkspaceDatabase(join(homedir(), '.pi-nest', 'workspace.sqlite'))
const branches = new SessionBranchStore(database)
if (!database.health.available) console.error('分支关系存储不可用', database.health.error)
try { await new SessionBranchService(branches, sessionIndex, runtime.attachments).recover() }
catch (cause) { console.error('分支关系恢复失败', { cause }) }
const app = createApp(runtime, runtimeSecurity, undefined, sessionIndex, branches)

const hostname = '127.0.0.1'
const port = 31415

const websocket = new WebSocketServer({ noServer: true })

const server = serve({ fetch: app.fetch, hostname, port, websocket: { server: websocket } }, ({ address, port: boundPort }) => {
  console.log(`Pi Nest server listening on ${process.env.PI_NEST_WEB_ORIGIN ?? `http://${address}:${boundPort}`}`)
})

function shutdown() {
  sessionIndex.close()
  server.close(() => { void runtime.close().finally(() => { database.close(); process.exit(0) }) })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
