import { Hono } from 'hono'

import { PiRuntimeRegistry } from './pi-runtime-registry.js'
import { createRuntimeRoutes } from './runtime-routes.js'
import { RuntimeSecurity } from './runtime-security.js'
import { createSessionRoutes } from './session-routes.js'

export function createApp(runtime = new PiRuntimeRegistry(), security = new RuntimeSecurity()) {
  return new Hono()
    .get('/api/health', (context) => context.json({ status: 'ok' }))
    .route('/api', createSessionRoutes(runtime))
    .route('/api', createRuntimeRoutes(runtime, security))
}

export const runtime = new PiRuntimeRegistry()
export const runtimeSecurity = new RuntimeSecurity()
export const app = createApp(runtime, runtimeSecurity)
