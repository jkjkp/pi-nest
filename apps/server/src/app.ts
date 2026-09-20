import { Hono } from 'hono'

export const app = new Hono().get('/api/health', (context) =>
  context.json({ status: 'ok' }),
)
