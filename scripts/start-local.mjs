import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { stageWebRelease } from './web-release.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const release = await stageWebRelease(new URL('../apps/web/dist', import.meta.url))
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, PI_NEST_WEB_RELEASE: release, PI_NEST_WEB_ORIGIN: 'http://localhost:31415' },
})
console.log('Pi Nest stable UI: http://localhost:31415 (source changes do not reload this release)')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal))
server.once('error', async (cause) => { console.error(cause); await rm(release, { recursive: true, force: true }); process.exitCode = 1 })
server.once('exit', async (code) => { await rm(release, { recursive: true, force: true }); process.exitCode = code ?? 1 })
