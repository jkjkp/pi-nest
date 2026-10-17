import { Hono } from 'hono'
import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveWebRelease } from './web-release.js'

it('serves fixed assets and SPA navigation without swallowing API or asset failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-test-'))
  try {
    await writeFile(join(directory, 'index.html'), '<main>Stable UI</main>')
    await mkdir(join(directory, 'assets'))
    await writeFile(join(directory, 'assets/app.js'), 'console.log("fixed")')
    const app = new Hono().get('/api/health', (c) => c.json({ status: 'ok' }))
    serveWebRelease(app, directory)
    expect(await (await app.request('/')).text()).toContain('Stable UI')
    expect(await (await app.request('/settings?session=one')).text()).toContain('Stable UI')
    expect(await (await app.request('/assets/app.js')).text()).toContain('fixed')
    expect((await app.request('/assets/missing.js')).status).toBe(404)
    expect((await app.request('/api/missing')).status).toBe(404)
    expect((await app.request('/api')).status).toBe(404)
    expect(await (await app.request('/api/health')).json()).toEqual({ status: 'ok' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
