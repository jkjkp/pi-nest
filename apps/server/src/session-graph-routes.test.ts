import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createSessionGraphRoutes } from './session-graph-routes.js'
import { SessionHistorySnapshots } from './session-history-snapshots.js'
import { RuntimeSecurity } from './runtime-security.js'
import { createSessionIndexFixture } from './test-fixtures/session-index.js'
import { SessionBranchStore } from './session-branch-store.js'
import { AttachmentStore } from './attachment-store.js'
import type { PiRuntimeRegistry } from './pi-runtime-registry.js'
it('protects graph reads, paginates snapshots and never exposes native filenames or loads Pi', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-graph-route-'))
  const security = new RuntimeSecurity('http://localhost:5173')
  const timestamp = new Date().toISOString(); const file = join(directory, 'private-source.jsonl')
  let parentId: string | null = null
  const lines: unknown[] = [{ type: 'session', version: 3, id: 'source', cwd: directory, timestamp }]
  for (let i = 0; i < 105; i++) { const id = `u${i}`; lines.push({ type: 'message', id, parentId, timestamp, message: { role: 'user', content: `Question ${i}`, timestamp: Date.now() } }); parentId = id }
  writeFileSync(file, lines.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const index = createSessionIndexFixture([{ id: 'source', cwd: directory, sessionFile: file, name: undefined, firstMessage: 'Question', updatedAt: timestamp }]).index
  const runtime = { history: new SessionHistorySnapshots(), attachments: new AttachmentStore(join(directory, 'attachments')) }
  const routes = createSessionGraphRoutes(runtime as PiRuntimeRegistry, security, index, new SessionBranchStore())
  const headers = { 'x-pi-nest-token': security.token }
  try {
    expect((await routes.request('/sessions/source/graph')).status).toBe(403)
    expect((await routes.request('/sessions/source/graph', { headers: { ...headers, origin: 'http://evil.test' } })).status).toBe(403)
    const skeleton = await (await routes.request('/sessions/source/graph', { headers })).text()
    expect(skeleton).not.toContain('private-source.jsonl')
    expect(skeleton).toContain('"available":false')
    const first = await (await routes.request('/sessions/source/graph-turns', { headers })).json()
    expect(first.entries).toHaveLength(100)
    expect(first.entries[99].beforeCursor).toBe('u100')
    const second = await (await routes.request(`/sessions/source/graph-turns?revision=${first.revision}&offset=${first.nextCursor}`, { headers })).json()
    expect(second.entries).toHaveLength(5)
    expect(second.entries[0].id).toBe('u100')
    expect((await routes.request('/sessions/source/graph-turns?offset=100', { headers })).status).toBe(400)
    expect((await routes.request(`/sessions/source/graph-turns?revision=${'0'.repeat(64)}&offset=100`, { headers })).status).toBe(409)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
