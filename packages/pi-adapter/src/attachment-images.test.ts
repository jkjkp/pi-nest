import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { preparePiImage } from './attachment-images.js'
import { PiRpcConnection } from './pi-rpc-connection.js'

export const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

it('fully decodes images using the installed Pi worker and rejects a valid header with broken pixels', async () => {
  const bytes = Buffer.from(png, 'base64')
  expect(await preparePiImage(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'), 'image/gif')).toMatchObject({ width: 1, height: 1 })
  expect(await preparePiImage(bytes, 'image/png')).toMatchObject({ width: 1, height: 1, image: { data: png } })
  await expect(preparePiImage(bytes.subarray(0, 35), 'image/png')).rejects.toThrow('解码')
})

it('real Pi RPC persists image-only prompts, delivers steering images, and restores native images without a paid provider', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-attachments-'))
  const agentDir = join(directory, 'agent')
  mkdirSync(agentDir)
  const requests: any[] = []
  let release: (() => void) | undefined
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    if (requests.length === 1) await new Promise<void>((done) => { release = done })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const delta = { id: 'test', object: 'chat.completion.chunk', model: 'vision', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }
    res.write(`data: ${JSON.stringify(delta)}\n\n`)
    res.write(`data: ${JSON.stringify({ ...delta, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    res.end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fake', models: [{ id: 'vision', name: 'Fixture', reasoning: false, input: ['text', 'image'], contextWindow: 32000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  const extension = join(agentDir, 'attachment-probe.ts')
  writeFileSync(extension, `export default function(pi) { pi.on('input', (event) => { if (event.text === 'handled') return { action: 'handled' }; if (event.text === 'transformed') return { action: 'transform', text: 'extension transformed input', images: [] }; }); }`)
  const manager = SessionManager.create(directory, join(directory, 'sessions'))
  const sessionFile = manager.getSessionFile()!
  const rpc = new PiRpcConnection({ cwd: directory, executable: resolve('node_modules/.bin/pi'), sessionFile,
    args: ['--mode', 'rpc', '--session', sessionFile, '--provider', 'fixture', '--model', 'vision', '--no-extensions', '--no-skills', '--no-tools', '--extension', extension],
    spawnProcess: (exe, args, options) => spawn(exe, args, { ...options, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }), commandTimeoutMs: 15000, stopTimeoutMs: 500 })
  try {
    await rpc.start()
    const image = (await preparePiImage(Buffer.from(png, 'base64'), 'image/png')).image
    await rpc.send({ type: 'prompt', message: '', images: [image] })
    await expect.poll(() => requests.length).toBe(1)
    await rpc.send({ type: 'steer', message: 'second', images: [image] })
    release!()
    await expect.poll(() => requests.length).toBe(2)
    await expect.poll(async () => (await rpc.send({ type: 'get_state' })).data).toMatchObject({ isStreaming: false })
    const users = SessionManager.open(sessionFile).getBranch().filter((e) => e.type === 'message' && e.message.role === 'user')
    expect(users).toHaveLength(2)
    for (const user of users) expect(JSON.stringify(user)).toContain(png)
    expect(JSON.stringify(requests[1])).toContain(`data:image/png;base64,${png}`)
    await rpc.send({ type: 'prompt', message: 'invalid native image', images: [{ type: 'image', data: Buffer.from('broken').toString('base64'), mimeType: 'image/png' }] })
    await expect.poll(() => requests.length).toBe(3)
    await expect.poll(async () => (await rpc.send({ type: 'get_state' })).data).toMatchObject({ isStreaming: false })
    const recorded = SessionManager.open(sessionFile).getBranch().filter((e) => e.type === 'message' && e.message.role === 'user')
    expect(JSON.stringify(recorded.at(-1))).toContain('Image omitted')
    const handled = await rpc.send({ type: 'prompt', message: 'handled', images: [image] })
    expect(handled.data).toMatchObject({ disposition: 'handled' })
    expect(requests).toHaveLength(3)
    await rpc.send({ type: 'prompt', message: 'transformed', images: [image] })
    await expect.poll(() => requests.length).toBe(4)
    await expect.poll(async () => (await rpc.send({ type: 'get_state' })).data).toMatchObject({ isStreaming: false })
    const transformed = SessionManager.open(sessionFile).getBranch().filter((e) => e.type === 'message' && e.message.role === 'user').at(-1)
    expect(JSON.stringify(transformed)).toContain('extension transformed input')
    expect(JSON.stringify(transformed)).not.toContain(png)
    const before = readFileSync(sessionFile)
    expect(SessionManager.open(sessionFile).getBranch()).toHaveLength(SessionManager.open(sessionFile).getBranch().length)
    expect(readFileSync(sessionFile)).toEqual(before)
  } finally { release?.(); await rpc.close(); await new Promise<void>((done) => server.close(() => done())); rmSync(directory, { recursive: true, force: true }) }
}, 25000)
