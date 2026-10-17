import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'
import { isAbsolute } from 'node:path'

export function serveWebRelease(app: Hono, directory: string) {
  if (!isAbsolute(directory)) throw new Error('Web release directory must be absolute')
  app.use('*', async (context, next) => {
    if (context.req.path === '/api' || context.req.path.startsWith('/api/')) return next()
    return serveStatic({ root: directory, onFound: (_path, context) => { context.header('Cache-Control', 'no-cache') } })(context, next)
  })
  app.get('*', (context, next) => {
    if (context.req.path === '/api' || context.req.path.startsWith('/api/') || context.req.path.startsWith('/assets/')) return next()
    context.header('Cache-Control', 'no-cache')
    return serveStatic({ root: directory, path: 'index.html' })(context, next)
  })
}
