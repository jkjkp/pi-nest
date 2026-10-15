import { beforeEach, expect, it, vi } from 'vitest'
import { createConfigurationRoutes } from './configuration-routes.js'
import { RuntimeSecurity } from './runtime-security.js'
import type { PiRuntimeRegistry } from './pi-runtime-registry.js'
import { configurationUpdateSchema } from './configuration-schema.js'
const api = vi.hoisted(() => ({ readPiConfiguration: vi.fn(), updatePiConfiguration: vi.fn(), listPiSessions: vi.fn(), diagnosePiMcp: vi.fn() }))
vi.mock('@pi-nest/pi-adapter', () => ({ ...api, PiConfigurationConflict: class extends Error {}, PiConfigurationInvalid: class extends Error {} }))
const security = new RuntimeSecurity('http://localhost:5173')
const finish = vi.fn()
const beginGlobalSettingsUpdate = vi.fn(() => finish as typeof finish | undefined)
const routes = () => createConfigurationRoutes({ beginGlobalSettingsUpdate } as unknown as PiRuntimeRegistry, security)
const headers = { origin: security.origin, 'x-pi-nest-token': security.token, 'content-type': 'application/json' }
beforeEach(() => { vi.clearAllMocks(); beginGlobalSettingsUpdate.mockReturnValue(finish); api.listPiSessions.mockResolvedValue([{ id: 'known', cwd: '/trusted' }]); api.readPiConfiguration.mockResolvedValue({ projectTrusted: false }); api.updatePiConfiguration.mockResolvedValue(undefined) })
it('protects reads and writes with a token, validates mutation origins, and disables caching', async () => {
  expect((await routes().request('/')).status).toBe(403)
  const read = await routes().request('/', { headers: { 'x-pi-nest-token': security.token } })
  expect(read.status).toBe(200); expect(read.headers.get('cache-control')).toBe('no-store')
  expect((await routes().request('/', { headers: { ...headers, origin: 'https://evil.example' } })).status).toBe(403)
  expect((await routes().request('/', { method: 'PATCH', headers: { 'x-pi-nest-token': security.token }, body: '{}' })).status).toBe(403)
})
it('resolves project paths on the server and reloads hosts after mutations', async () => {
  const response = await routes().request('/?session=known', { method: 'PATCH', headers, body: JSON.stringify({ category: 'models', values: { retryEnabled: false } }) })
  expect(response.status).toBe(200)
  expect(api.updatePiConfiguration).toHaveBeenCalledWith('/trusted', { category: 'models', values: { retryEnabled: false } })
  expect(finish).toHaveBeenCalledWith(true)
})
it('rejects missing projects, invalid data and busy runtimes without saving', async () => {
  expect((await routes().request('/?session=missing', { headers })).status).toBe(404)
  expect((await routes().request('/', { method: 'PATCH', headers, body: JSON.stringify({ category: 'models', values: { defaultThinkingLevel: 'invented' } }) })).status).toBe(400)
  beginGlobalSettingsUpdate.mockReturnValue(undefined)
  expect((await routes().request('/', { method: 'PATCH', headers, body: JSON.stringify({ category: 'models', values: { retryEnabled: false } }) })).status).toBe(409)
  expect(api.updatePiConfiguration).not.toHaveBeenCalled()
})
it('releases the runtime lock even if native persistence fails', async () => {
  api.updatePiConfiguration.mockRejectedValueOnce(new Error('private/path/key'))
  const response = await routes().request('/', { method: 'PATCH', headers, body: JSON.stringify({ category: 'models', values: { retryEnabled: true } }) })
  expect(response.status).toBe(500); expect(await response.text()).not.toContain('private/path/key'); expect(finish).toHaveBeenCalledWith(true)
})
it('validates MCP transport combinations and rejects provider auth from a project', () => {
  const base = { category: 'mcp', scope: 'global', name: 'tools', revision: 'a'.repeat(64) }
  for (const value of [{ type: 'sse', url: 'https://example.com' }, { command: 'node', url: 'https://example.com' }, { type: 'http' }, { url: 'file:///private' }, { command: 'node', timeout: -1 }]) expect(configurationUpdateSchema.safeParse({ ...base, value }).success).toBe(false)
  expect(configurationUpdateSchema.safeParse({ ...base, value: { command: 'node', args: ['server.js'], env: { KEY: '${TOKEN}' } } }).success).toBe(true)
  expect(configurationUpdateSchema.safeParse({ ...base, scope: 'project', value: { url: 'https://example.com', auth: { provider: 'openai' } } }).success).toBe(false)
})
