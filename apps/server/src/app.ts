import { Hono } from 'hono'

import { createSessionRoutes } from './session-routes.js'

export const app = new Hono()
  .get('/api/health', (context) => context.json({ status: 'ok' }))
  .route('/api', createSessionRoutes())
