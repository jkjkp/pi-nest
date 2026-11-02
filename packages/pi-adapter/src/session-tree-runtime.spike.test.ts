import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { PiRpcConnection } from './pi-rpc-connection.js'
import { readPiSessionHistory } from './read-session-history.js'

// Verification only: the temporary command exposes the installed SDK's tree navigation over real RPC.
it.each([false, true])('edits the last user in one native file and restores it in a fresh Pi process (root=%s)', async (root) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-nest-tree-spike-'))
  const agentDir = join(directory, 'agent')
  const sessionDir = join(directory, 'sessions')
  mkdirSync(agentDir)
  const requests: { messages: unknown[] }[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    if (body.includes('FAIL_PROMPT')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Fixture provider failure', type: 'invalid_request_error' } }))
      return
    }
    const chunk = { id: 'tree-spike', object: 'chat.completion.chunk', model: 'tree', choices: [{ index: 0, delta: { role: 'assistant', content: `NEW_ANSWER_${requests.length}` }, finish_reason: null }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fake', models: [{ id: 'tree', name: 'Tree spike', reasoning: false, input: ['text', 'image'], contextWindow: 32000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'tree', compaction: { enabled: false }, retry: { enabled: false } }))
  const extension = join(agentDir, 'tree-probe.ts')
  writeFileSync(extension, `export default function(pi) {
    let cancel = false;
    pi.on('session_before_tree', () => cancel ? { cancel: true } : undefined);
    pi.on('input', (event) => event.text === 'HANDLED_INPUT' ? { action: 'handled' } : undefined);
    pi.registerCommand('tree-probe', { handler: async (args, ctx) => {
      const input = JSON.parse(args);
      cancel = input.cancel === true;
      const result = await ctx.navigateTree(input.entryId, { summarize: false });
      if (!result.cancelled && input.persist) pi.appendEntry('pi-nest-tree-probe-position', { entryId: input.entryId });
      ctx.ui.notify('TREE_RESULT:' + JSON.stringify(result));
    }});
  }`)
  const manager = SessionManager.create(directory, sessionDir)
  const sessionFile = manager.getSessionFile()!
  const sessionId = manager.getSessionId()
  const assistant = (content: { type: 'text'; text: string }[] | { type: 'toolCall'; id: string; name: string; arguments: Record<string, string> }[]) => ({
    role: 'assistant' as const, content, api: 'openai-completions' as const, provider: 'fixture', model: 'tree',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as const, timestamp: Date.now(),
  })
  if (!root) {
    manager.appendMessage({ role: 'user', content: 'KEEP_QUESTION', timestamp: Date.now() })
    manager.appendMessage(assistant([{ type: 'text', text: 'KEEP_ANSWER' }]))
  }
  const oldUserId = manager.appendMessage({ role: 'user', content: 'DISCARD_QUESTION', timestamp: Date.now() })
  const parentId = manager.getEntry(oldUserId)!.parentId
  manager.appendMessage(assistant([{ type: 'toolCall', id: 'old-call', name: 'read', arguments: { path: 'DISCARD_PATH' } }]))
  manager.appendMessage({ role: 'toolResult', toolCallId: 'old-call', toolName: 'read', content: [{ type: 'text', text: 'DISCARD_TOOL_RESULT' }], isError: false, timestamp: Date.now() })
  manager.appendMessage(assistant([{ type: 'text', text: 'DISCARD_ANSWER' }]))
  const originalEntries = manager.getEntries()
  let rpc: PiRpcConnection
  const notifications: Record<string, unknown>[] = []
  async function start() {
    rpc = new PiRpcConnection({ cwd: directory, executable: resolve('node_modules/.bin/pi'), sessionFile,
      args: ['--mode', 'rpc', '--session', sessionFile, '--no-extensions', '--no-skills', '--no-tools', '--extension', extension],
      spawnProcess: (exe, args, options) => spawn(exe, args, { ...options, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }), commandTimeoutMs: 15000, stopTimeoutMs: 500 })
    rpc.onRecord((record) => notifications.push(record))
    await rpc.start()
    expect((await rpc.send({ type: 'get_state' })).data).toMatchObject({ sessionId, sessionFile })
  }
  async function navigate(entryId: string, cancel = false, persist = false) {
    const before = notifications.length
    await rpc.send({ type: 'prompt', message: `/tree-probe ${JSON.stringify({ entryId, cancel, persist })}` })
    const result = notifications.slice(before).find((record) => typeof record.message === 'string' && record.message.startsWith('TREE_RESULT:'))
    expect(result).toBeDefined()
    expect(JSON.parse(String(result!.message).slice('TREE_RESULT:'.length))).toEqual({ cancelled: cancel })
  }
  async function prompt(message: string, images?: { type: 'image'; data: string; mimeType: string }[]) {
    const before = notifications.filter((record) => record.type === 'agent_settled').length
    await rpc.send({ type: 'prompt', message, ...(images ? { images } : {}) })
    await expect.poll(() => notifications.filter((record) => record.type === 'agent_settled').length, { timeout: 15000 }).toBe(before + 1)
  }
  const messages = async () => JSON.stringify((await rpc.send({ type: 'get_messages' })).data)
  try {
    await start()
    await expect(rpc!.send({ type: 'navigate_tree', targetId: oldUserId })).rejects.toThrow()
    const beforeCancel = readFileSync(sessionFile)
    await navigate(oldUserId, true)
    expect(await messages()).toContain('DISCARD_ANSWER')
    expect(readFileSync(sessionFile)).toEqual(beforeCancel)

    await navigate(oldUserId)
    expect((await rpc!.send({ type: 'get_entries' })).data).toMatchObject({ leafId: parentId })
    expect(await messages()).not.toContain('DISCARD_')
    if (!root) expect(await messages()).toContain('KEEP_ANSWER')
    expect(readFileSync(sessionFile)).toEqual(beforeCancel)
    await rpc!.close()
    await start()
    expect(await messages()).toContain('DISCARD_ANSWER')

    await navigate(oldUserId, false, true)
    await rpc!.close()
    await start()
    expect(await messages()).not.toContain('DISCARD_')
    await navigate(originalEntries.at(-1)!.id, false, true)
    await rpc!.close()
    await start()
    expect(await messages()).toContain('DISCARD_ANSWER')

    await navigate(oldUserId)
    expect((await rpc!.send({ type: 'prompt', message: 'HANDLED_INPUT' })).data).toMatchObject({ disposition: 'handled' })
    expect(requests).toHaveLength(0)
    await rpc!.close()
    await start()
    expect(await messages()).toContain('DISCARD_ANSWER')

    await navigate(oldUserId)
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
    await prompt('EDITED_QUESTION', [{ type: 'image', data: png, mimeType: 'image/png' }])
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).not.toContain('DISCARD_')
    expect(JSON.stringify(requests[0].messages)).toContain('EDITED_QUESTION')
    expect(JSON.stringify(requests[0].messages)).toContain(`data:image/png;base64,${png}`)
    expect(JSON.stringify(requests[0].messages).includes('KEEP_ANSWER')).toBe(!root)
    const reopened = SessionManager.open(sessionFile)
    expect(reopened.getSessionId()).toBe(sessionId)
    expect(reopened.getHeader()?.parentSession).toBeUndefined()
    for (const entry of originalEntries) expect(reopened.getEntries()).toContainEqual(entry)
    const edited = reopened.getBranch().findLast((entry) => entry.type === 'message' && entry.message.role === 'user')!
    const branch = reopened.getBranch()
    const parentIndex = parentId === null ? -1 : branch.findIndex((entry) => entry.id === parentId)
    // Pi refreshes the system prompt on the new branch before persisting the edited user.
    const inserted = branch.slice(parentIndex + 1, branch.findIndex((entry) => entry.id === edited.id))
    expect(inserted).toMatchObject([{ type: 'message', parentId, message: { role: 'system' } }])
    expect(edited.parentId).toBe(inserted[0]!.id)
    expect(JSON.stringify(reopened.getBranch())).not.toContain('DISCARD_')
    const history = readPiSessionHistory({ sessionFile, expectedSessionId: sessionId, expectedCwd: directory })
    expect(JSON.stringify(history.entries)).not.toContain('DISCARD_')
    expect(JSON.stringify(history.entries)).toContain('EDITED_QUESTION')

    await rpc!.close()
    await start()
    expect(await messages()).toContain('NEW_ANSWER_1')
    expect(await messages()).not.toContain('DISCARD_')
    await navigate(edited.id)
    await prompt('EDITED_AGAIN')
    expect(JSON.stringify(requests[1].messages)).not.toContain('EDITED_QUESTION')
    expect(JSON.stringify(requests[1].messages)).toContain('EDITED_AGAIN')
    await rpc!.close()
    await start()
    expect(await messages()).toContain('EDITED_AGAIN')
    expect(await messages()).not.toContain('EDITED_QUESTION')
    await prompt('FOLLOW_UP')
    expect(JSON.stringify(requests[2].messages)).toContain('EDITED_AGAIN')
    expect(JSON.stringify(requests[2].messages)).not.toContain('DISCARD_')
    const followUp = SessionManager.open(sessionFile).getBranch().findLast((entry) => entry.type === 'message' && entry.message.role === 'user')!
    await navigate(followUp.id)
    await prompt('FAIL_PROMPT')
    expect(JSON.stringify(requests[3].messages)).not.toContain('FOLLOW_UP')
    await rpc!.close()
    await start()
    expect(await messages()).toContain('FAIL_PROMPT')
    expect(await messages()).not.toContain('FOLLOW_UP')
    expect(readdirSync(sessionDir).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1)
  } finally {
    await rpc!?.close()
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(directory, { recursive: true, force: true })
  }
}, 45000)
