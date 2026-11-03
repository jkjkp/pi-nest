import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { PiRpcProcess, capturePiSessionHistory } from '@pi-nest/pi-adapter'
import { PiRuntimeHost } from './pi-runtime-host.js'
import { PiRuntimeRegistry } from './pi-runtime-registry.js'
import { WorkspaceDatabase } from './workspace-database.js'
import { SessionBranchStore } from './session-branch-store.js'
import { SessionBranchService } from './session-branch-service.js'
import { createSessionIndexFixture } from './test-fixtures/session-index.js'

it('creates an independent branch, prompts a real isolated Pi, and reopens its relation and history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-tree-real-')); const agentDir = join(directory, 'agent'); mkdirSync(agentDir)
  const requests: unknown[] = []
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; requests.push(JSON.parse(body))
    const chunk = { id: 'branch', object: 'chat.completion.chunk', model: 'branch', choices: [{ index: 0, delta: { role: 'assistant', content: 'BRANCH_RESULT' }, finish_reason: null }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done))
  const port = (provider.address() as { port: number }).port
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fake', models: [{ id: 'branch', name: 'Branch', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'branch', retry: { enabled: false }, compaction: { enabled: false } }))
  const source = { id: 'source', cwd: directory, sessionFile: join(directory, 'source.jsonl') }
  const timestamp = new Date().toISOString()
  writeFileSync(source.sessionFile, [
    { type: 'session', version: 3, id: source.id, cwd: directory, timestamp },
    { type: 'message', id: 'question', parentId: null, timestamp, message: { role: 'user', content: 'ORIGINAL', timestamp: Date.now() } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const original = readFileSync(source.sessionFile)
  const index = createSessionIndexFixture([{ ...source, name: undefined, firstMessage: 'ORIGINAL', updatedAt: timestamp }]).index
  const runtime = new PiRuntimeRegistry({ eventBufferDirectory: join(directory, 'events'), projectionDirectory: join(directory, 'projections'), attachmentDirectory: join(directory, 'attachments'), createHost: (binding) => new PiRuntimeHost(binding, () => new PiRpcProcess({ cwd: binding.cwd, expectedSessionId: binding.id, sessionFile: binding.sessionFile, piExecutable: resolve('../../packages/pi-adapter/node_modules/.bin/pi'), spawnProcess: (exe, args, options) => spawn(exe, args, { ...options, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }) })) })
  let db = new WorkspaceDatabase(join(directory, 'db.sqlite'))
  try {
    const operationId = randomUUID()
    const service = new SessionBranchService(new SessionBranchStore(db), index, runtime.attachments)
    const result = service.create(source, { kind: 'clone', operationId }, undefined, {})
    expect('session' in result).toBe(true)
    if (!('session' in result)) throw new Error('branch not ready')
    const child = { ...(await index.resolve(result.session.id))!, cwd: directory }
    const prompt = runtime.beginPrompt(child, 'CHILD_ONLY')!
    await prompt.accepted; await prompt.settled
    await runtime.close()
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0])).toContain('ORIGINAL')
    expect(JSON.stringify(requests[0])).toContain('CHILD_ONLY')
    expect(readFileSync(source.sessionFile)).toEqual(original)
    expect(JSON.stringify(capturePiSessionHistory({ ...child, expectedSessionId: child.id }).entries)).toContain('BRANCH_RESULT')
    db.close(); db = new WorkspaceDatabase(join(directory, 'db.sqlite'))
    const reopened = new SessionBranchService(new SessionBranchStore(db), index, runtime.attachments)
    await reopened.recover()
    expect((await reopened.operation(source.id, operationId))?.result?.session.id).toBe(child.id)
  } finally { db.close(); await runtime.close(); provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done())); rmSync(directory, { recursive: true, force: true }) }
}, 20000)
