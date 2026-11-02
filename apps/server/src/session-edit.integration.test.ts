import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { PiRpcProcess } from '@pi-nest/pi-adapter'
import { PiRuntimeHost } from './pi-runtime-host.js'
import { PiRuntimeRegistry } from './pi-runtime-registry.js'

it('edits once in a real runtime, publishes the history boundary to both observers and keeps restart history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-nest-edit-integration-'))
  const agentDir = join(directory, 'agent')
  mkdirSync(agentDir)
  const requests: unknown[] = []
  let finishResponse: (() => void) | undefined
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    await new Promise<void>((done) => { finishResponse = done })
    const chunk = { id: 'edit', object: 'chat.completion.chunk', model: 'edit', choices: [{ index: 0, delta: { role: 'assistant', content: 'NEW_ANSWER' }, finish_reason: null }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fake', models: [{ id: 'edit', name: 'Edit', reasoning: false, input: ['text', 'image'], contextWindow: 32000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  const inputExtension = join(agentDir, 'input.ts')
  writeFileSync(inputExtension, "export default function(pi) { pi.on('input', event => event.text === 'HANDLED' ? { action: 'handled' } : undefined); }")
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'edit', retry: { enabled: false }, compaction: { enabled: false }, extensions: [inputExtension] }))
  const session = { id: 'source', cwd: directory, sessionFile: join(directory, 'source.jsonl') }
  const timestamp = new Date().toISOString()
  writeFileSync(session.sessionFile, [
    { type: 'session', version: 3, id: session.id, cwd: directory, timestamp },
    { type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: 'OLD_QUESTION', timestamp: Date.now() } },
    { type: 'message', id: 'answer', parentId: 'user', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'OLD_ANSWER' }], api: 'openai-completions', model: 'edit', provider: 'fixture', stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n')
  function registry() {
    return new PiRuntimeRegistry({ eventBufferDirectory: join(directory, 'events'), projectionDirectory: join(directory, 'projections'), attachmentDirectory: join(directory, 'attachments'), createHost: (binding) => new PiRuntimeHost(binding, () => new PiRpcProcess({ cwd: binding.cwd, expectedSessionId: binding.id, sessionFile: binding.sessionFile,
      piExecutable: resolve('../../packages/pi-adapter/node_modules/.bin/pi'), spawnProcess: (exe, args, options) => spawn(exe, args, { ...options, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }) })) })
  }
  let runtime = registry()
  try {
    await runtime.resume(session)
    const first: any[] = [], second: any[] = []
    await runtime.subscribe(session.id, 0, (event) => first.push(event), () => undefined)
    await runtime.subscribe(session.id, 0, (event) => second.push(event), () => undefined)
    const cancelInput = { entryId: 'user', revision: createHash('sha256').update(readFileSync(session.sessionFile)).digest('hex'), message: 'CANCELLED', submissionId: randomUUID() }
    const stopped = expect(runtime.editLast(session, cancelInput)).rejects.toMatchObject({ code: 'EDIT_CANCELLED' })
    expect(await runtime.abort(session.id)).toBe(true)
    await stopped
    expect(requests).toHaveLength(0)
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
    const image = await runtime.attachments.upload(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(png, 'base64')); controller.close() } }), session.id, 'edit.png', 'image/png')
    const input = { attachmentIds: [image.id], entryId: 'user', revision: createHash('sha256').update(readFileSync(session.sessionFile)).digest('hex'), message: 'NEW_QUESTION', submissionId: randomUUID() }
    const prepared = await runtime.attachments.prepare(session.id, input)
    await expect(runtime.editLast(session, { ...input, revision: '0'.repeat(64) }, prepared)).rejects.toMatchObject({ code: 'HISTORY_REVISION_CHANGED' })
    const committed = await runtime.editLast(session, input, prepared)
    expect(committed).toMatchObject({ status: 'committed', submissionId: input.submissionId })
    await expect.poll(() => requests.length).toBe(1)
    expect(JSON.stringify(requests)).not.toContain('OLD_')
    expect(JSON.stringify(requests)).toContain('data:image/png;base64,')
    expect(JSON.stringify(runtime.history.history(session))).not.toContain('OLD_')
    expect(first.filter((event) => event.event.type === 'history_changed')).toHaveLength(1)
    expect(second.filter((event) => event.event.type === 'history_changed')).toEqual(first.filter((event) => event.event.type === 'history_changed'))
    const boundary = first.find((event) => event.event.type === 'history_changed')!
    expect(first.findIndex((event) => event.event.type === 'agent_start')).toBeGreaterThan(first.indexOf(boundary))
    expect(boundary.event.change.sequence).toBe(boundary.sequence)
    expect(await runtime.editLast(session, input)).toEqual(committed)
    await expect(runtime.editLast(session, { ...input, message: 'DIFFERENT' })).rejects.toMatchObject({ code: 'SUBMISSION_CONFLICT' })
    await expect(runtime.editLast(session, { ...input, submissionId: randomUUID() }, prepared)).rejects.toThrow('busy')
    finishResponse!()
    await expect.poll(() => JSON.stringify(runtime.history.history(session)).includes('NEW_ANSWER')).toBe(true)
    const handled = { entryId: committed.userEntryId!, revision: createHash('sha256').update(readFileSync(session.sessionFile)).digest('hex'), message: 'HANDLED', submissionId: randomUUID() }
    await expect(runtime.editLast(session, handled)).rejects.toMatchObject({ code: 'EDIT_CANCELLED' })
    expect(runtime.getEditStatus(session, handled.submissionId).status).toBe('rolled_back')
    expect(JSON.stringify(runtime.history.history(session))).toContain('NEW_ANSWER')
    expect(requests).toHaveLength(1)
    await runtime.close()
    runtime = registry()
    await runtime.resume(session)
    expect(runtime.getEditStatus(session, input.submissionId)).toEqual(committed)
    expect(JSON.stringify(runtime.history.history(session))).not.toContain('OLD_')
    expect(readdirSync(directory).filter((name) => name.endsWith('.jsonl'))).toEqual(['source.jsonl'])
  } finally {
    finishResponse?.()
    await runtime.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(directory, { recursive: true, force: true })
  }
}, 20000)
