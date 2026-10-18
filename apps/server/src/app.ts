import { createAttachmentRoutes } from './attachment-routes.js'
import { createSessionFilePreviewRoutes } from './session-file-preview.js'
import { serveWebRelease } from './web-release.js'
import { Hono } from 'hono'
import { configurationSecurity, createConfigurationRoutes } from './configuration-routes.js'

import { PiRuntimeRegistry } from './pi-runtime-registry.js'
import { createRuntimeRoutes } from './runtime-routes.js'
import { RuntimeSecurity } from './runtime-security.js'
import { ProjectRegistry } from './project-registry.js'
import { createProjectRoutes } from './project-routes.js'
import { createSessionRoutes } from './session-routes.js'

export function createApp(runtime = new PiRuntimeRegistry(), security = new RuntimeSecurity(), projects = new ProjectRegistry()) {
  const app = new Hono()
    .get('/api/health', (context) => context.json({ status: 'ok' }))
    .route('/api/configuration', createConfigurationRoutes(runtime, security))
    .use('/api/sessions/:sessionId/settings', configurationSecurity(security))
    .route('/api/attachments', createAttachmentRoutes(runtime.attachments, security, projects))
    .route('/api/projects', createProjectRoutes(projects, security))
    .route('/api', createSessionFilePreviewRoutes(security))
    .route('/api', createSessionRoutes(runtime, projects, security))
    .route('/api', createRuntimeRoutes(runtime, security))
  if (process.env.PI_NEST_WEB_RELEASE) serveWebRelease(app, process.env.PI_NEST_WEB_RELEASE)
  return app
}

export const runtime = new PiRuntimeRegistry()
export const runtimeSecurity = new RuntimeSecurity()
export const app = createApp(runtime, runtimeSecurity)
