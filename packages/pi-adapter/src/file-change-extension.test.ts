import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { PiRpcProcess } from './pi-rpc-process.js'
import { branchPiSession } from './branch-session.js'

it('loads the bundled extension in real Pi RPC and persists net counts through history and cloning', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-file-change-rpc-'))
  const agentDir = join(directory, 'agent')
  mkdirSync(agentDir)
  writeFileSync(join(directory, 'existing.txt'), 'original\nkeep\n')
  let request = 0
  const actions = [
    { name: 'write', arguments: { path: 'new.txt', content: 'one\n' } },
    { name: 'write', arguments: { path: 'existing.txt', content: 'temporary\nkeep\n' } },
    { name: 'edit', arguments: { path: 'existing.txt', edits: [{ oldText: 'temporary', newText: 'final' }] } },
    undefined,
    { name: 'write', arguments: { path: 'existing.txt', content: 'original\nkeep\n' } },
  ]
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the local fixture request. */ }
    const action = actions[request++]
    const delta = action ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${request}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] } : { role: 'assistant', content: 'done' }
    const chunk = { id: 'fixture', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, delta, finish_reason: null as string | null }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: action ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fake', models: [{ id: 'test', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'test' }))
  const manager = SessionManager.create(directory, join(directory, 'sessions'))
  const sessionFile = manager.getSessionFile()!
  writeFileSync(sessionFile, JSON.stringify(manager.getHeader()) + '\n')
  const events: Record<string, unknown>[] = []
  const rpc = new PiRpcProcess({ cwd: directory, expectedSessionId: manager.getSessionId(), sessionFile, piExecutable: resolve('node_modules/.bin/pi'),
    spawnProcess: (exe, args, options) => spawn(exe, args, { ...options, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }) })
  rpc.onEvent((event) => events.push(event))
  try {
    await rpc.start()
    await rpc.send({ type: 'prompt', message: 'modify the fixtures' })
    await expect.poll(() => events.some((event) => event.type === 'agent_settled'), { timeout: 15000 }).toBe(true)
    const entries = SessionManager.open(sessionFile).getBranch()
    const tools = entries.filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult')
    expect(tools).toHaveLength(3)
    expect(tools.map((entry) => entry.type === 'message' && entry.message.role === 'toolResult' ? (entry.message.details as { piNestFileChange: unknown }).piNestFileChange : undefined)).toMatchObject([
      { added: 1, removed: 0, changeType: 'created' },
      { added: 1, removed: 1 },
      { added: 1, removed: 1 },
    ])
    const summary = entries.findLast((entry) => entry.type === 'custom' && entry.customType === 'pi-nest-file-changes')
    expect(summary).toMatchObject({ data: { turnId: entries.find((entry) => entry.type === 'message' && entry.message.role === 'user')?.id, files: [
      { path: join(directory, 'new.txt'), added: 1, removed: 0 },
      { path: join(directory, 'existing.txt'), added: 1, removed: 1 },
    ] } })
    expect(readFileSync(join(directory, 'existing.txt'), 'utf8')).toBe('final\nkeep\n')
    expect(events.filter((event) => event.type === 'tool_execution_end').map((event) => event.result)).toMatchObject([
      { details: { piNestFileChange: { added: 1, removed: 0 } } },
      { details: { piNestFileChange: { added: 1, removed: 1 } } },
      { details: { piNestFileChange: { added: 1, removed: 1 } } },
    ])
    const clone = branchPiSession({ kind: 'clone', sessionFile, expectedSessionId: manager.getSessionId(), expectedCwd: directory })
    expect(SessionManager.open(clone.session.sessionFile).getBranch()).toContainEqual(summary)
    const prior = readFileSync(sessionFile)
    const reply = entries.findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant')!
    const fork = branchPiSession({ kind: 'fork', entryId: reply.id, revision: createHash('sha256').update(prior).digest('hex'), sessionFile, expectedSessionId: manager.getSessionId(), expectedCwd: directory })
    const forked = SessionManager.open(fork.session.sessionFile).getBranch()
    expect(forked.filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult').at(-1)).toMatchObject({ message: { details: { piNestFileChange: { added: 1, removed: 1 } } } })
    const persisted = JSON.stringify(summary)
    expect(persisted).not.toContain('original\\n')
    expect(persisted).not.toContain('final\\n')
    expect(readFileSync(sessionFile)).toEqual(prior)
    const settled = events.filter((event) => event.type === 'agent_settled').length
    await rpc.send({ type: 'prompt', message: 'restore original contents in a new turn' })
    await expect.poll(() => events.filter((event) => event.type === 'agent_settled').length, { timeout: 15000 }).toBe(settled + 1)
    const nextSummary = SessionManager.open(sessionFile).getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === 'pi-nest-file-changes')
    expect(nextSummary).toMatchObject({ data: { files: [{ path: join(directory, 'existing.txt'), added: 1, removed: 1 }] } })
    expect(readFileSync(join(directory, 'existing.txt'), 'utf8')).toBe('original\nkeep\n')
  } finally {
    await rpc.close()
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(directory, { recursive: true, force: true })
  }
}, 25000)
