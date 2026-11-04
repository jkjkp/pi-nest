import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { PiRpcProcess } from './pi-rpc-process.js'
import { piEditStatus, readPiEditEntries } from './session-edit.js'

it.each(['prepared', 'tree-hook', 'selected', 'system', 'user', 'compacted', 'handled', 'transformed', 'cancelled', 'spawned', 'foreign'] as const)('preserves a real Pi session through edit stage %s without creating a session', async (stage) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-edit-recovery-'))
  const agentDir = join(directory, 'agent')
  const sessions = join(directory, 'sessions')
  mkdirSync(agentDir); mkdirSync(sessions)
  let child: ChildProcessWithoutNullStreams | undefined
  let requestText = ''
  const server = createServer(async (req, res) => {
    for await (const chunk of req) requestText += chunk
    if (stage === 'user') child!.kill('SIGKILL')
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Test provider failure', type: 'invalid_request_error' } }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fake', models: [{ id: 'edit', name: 'Edit', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  const faultExtension = join(agentDir, 'fault.ts')
  writeFileSync(faultExtension, `export default function(pi) {
    pi.on('session_before_tree', () => { if (process.env.EDIT_FAULT === 'prepared') process.kill(process.pid, 'SIGKILL'); if (process.env.EDIT_FAULT === 'cancelled') return { cancel: true }; });
    pi.on('message_start', ({message}) => { if (process.env.EDIT_FAULT === 'system' && message.role === 'user') process.kill(process.pid, 'SIGKILL'); });
    pi.on('session_tree', () => { if (process.env.EDIT_FAULT === 'tree-hook') { pi.appendEntry('fixture-tree-hook', {}); process.kill(process.pid, 'SIGKILL'); } });
    pi.on('input', (event) => {
      if (event.text !== 'NEW_QUESTION') return;
      if (process.env.EDIT_FAULT === 'handled') return { action: 'handled' };
      if (process.env.EDIT_FAULT === 'transformed') return { action: 'transform', text: 'TRANSFORMED_QUESTION', images: [] };
      if (process.env.EDIT_FAULT === 'spawned') { pi.sendUserMessage('SPAWNED_QUESTION'); return { action: 'handled' }; }
    });
  }`)
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'edit', retry: { enabled: false }, compaction: { enabled: false }, extensions: [faultExtension] }))
  const sessionFile = join(sessions, 'source.jsonl')
  const timestamp = new Date().toISOString()
  writeFileSync(sessionFile, [
    { type: 'session', version: 3, id: 'source', cwd: directory, timestamp },
    { type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: 'OLD_QUESTION', timestamp: Date.now() } },
    { type: 'message', id: 'answer', parentId: 'user', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'OLD_ANSWER' }], api: 'openai-completions', model: 'edit', provider: 'fixture', stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n')
  if (stage === 'compacted') {
    const lines = readFileSync(sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    lines[1].parentId = 'keep-compaction'
    lines.splice(1, 0,
      { type: 'message', id: 'base-user', parentId: null, timestamp, message: { role: 'user', content: 'KEEP_BASE', timestamp: Date.now() } },
      { ...lines[2], id: 'base-answer', parentId: 'base-user', message: { ...lines[2].message, content: [{ type: 'text', text: 'KEEP_ANSWER' }] } },
      { type: 'compaction', id: 'keep-compaction', parentId: 'base-answer', timestamp, summary: 'KEEP_SUMMARY', firstKeptEntryId: 'base-user', tokensBefore: 10 },
    )
    lines.push({ type: 'compaction', id: 'discard-compaction', parentId: 'answer', timestamp, summary: 'DISCARD_SUMMARY', firstKeptEntryId: 'user', tokensBefore: 10 })
    writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  }
  function runtime(fault = '') {
    return new PiRpcProcess({ cwd: directory, expectedSessionId: 'source', sessionFile, piExecutable: resolve('node_modules/.bin/pi'),
      spawnProcess: (exe, args, options) => {
        child = spawn(exe, args, { ...options, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, EDIT_FAULT: fault } })
        return child
      } })
  }
  let rpc = runtime(stage)
  const submissionId = '00000000-0000-4000-8000-000000000001'
  try {
    await rpc.start()
    const commands = await rpc.send({ type: 'get_commands' })
    expect(JSON.stringify(commands)).not.toContain('__pi_nest_edit')
    await expect(rpc.send({ type: 'prompt', message: '/__pi_nest_edit {}' })).rejects.toThrow('Internal')
    const prepare = rpc.send({ type: 'pi_nest_edit', action: 'prepare', submissionId, entryId: 'user', revision: createHash('sha256').update(readFileSync(sessionFile)).digest('hex'), requestHash: 'request', runId: 'edit-run' })
    if (stage === 'prepared' || stage === 'tree-hook') await expect(prepare).rejects.toThrow()
    else {
      const result = await prepare
      expect(result.data).toMatchObject({ phase: stage === 'cancelled' ? 'rolled_back' : 'selected' })
      if (stage === 'foreign') {
        appendFileSync(sessionFile, JSON.stringify({ type: 'message', id: 'foreign-user', parentId: 'answer', timestamp, message: { role: 'user', content: 'EXTERNAL_QUESTION', timestamp: Date.now() } }) + '\n')
        await rpc.close()
        const bytes = readFileSync(sessionFile)
        rpc = runtime()
        await expect(rpc.start()).rejects.toThrow('Failed to start Pi RPC process')
        expect(readFileSync(sessionFile)).toEqual(bytes)
        return
      }
      if (stage === 'selected') child!.kill('SIGKILL')
      else if (stage !== 'cancelled') {
        await rpc.send({ type: 'prompt', message: 'NEW_QUESTION' }).catch(() => undefined)
        if (stage === 'system' || stage === 'user') await expect.poll(() => child?.exitCode !== null || child?.signalCode !== null).toBe(true)
        else if (stage === 'handled') await rpc.send({ type: 'pi_nest_edit', action: 'recover' })
        else await expect.poll(() => piEditStatus(readPiEditEntries(sessionFile), submissionId).status).toBe('committed')
        // A committed user entry precedes the provider request; do not shut down before observing it.
        if (stage === 'compacted') await expect.poll(() => requestText).toContain('KEEP_SUMMARY')
      }
    }
    await rpc.close()
    rpc = runtime()
    if (stage === 'tree-hook') {
      const bytes = readFileSync(sessionFile)
      await expect(rpc.start()).rejects.toThrow('Failed to start Pi RPC process')
      expect(readFileSync(sessionFile)).toEqual(bytes)
      expect(readFileSync(sessionFile, 'utf8')).toContain('OLD_ANSWER')
      return
    }
    await rpc.start()
    const messages = JSON.stringify((await rpc.send({ type: 'get_messages' })).data)
    const committed = ['user', 'compacted', 'transformed', 'spawned'].includes(stage)
    const expectedNew = stage === 'transformed' ? 'TRANSFORMED_QUESTION' : stage === 'spawned' ? 'SPAWNED_QUESTION' : 'NEW_QUESTION'
    expect(messages.includes(expectedNew)).toBe(committed)
    expect(messages.includes('OLD_ANSWER')).toBe(!committed)
    expect(piEditStatus(readPiEditEntries(sessionFile), submissionId).status).toBe(committed ? 'committed' : 'rolled_back')
    if (stage === 'compacted') { expect(requestText).toContain('KEEP_SUMMARY'); expect(requestText).not.toContain('DISCARD_SUMMARY') }
    const bytes = readFileSync(sessionFile)
    await rpc.close()
    rpc = runtime()
    await rpc.start()
    expect(readFileSync(sessionFile)).toEqual(bytes)
    expect(readdirSync(sessions)).toEqual(['source.jsonl'])
  } finally {
    await rpc.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(directory, { recursive: true, force: true })
  }
}, 20000)
