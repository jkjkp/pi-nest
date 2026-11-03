import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { WorkspaceDatabase } from './workspace-database.js'
import { SessionBranchStore } from './session-branch-store.js'
import { SessionBranchService } from './session-branch-service.js'
import { PiSessionIndex } from './session-index.js'
import { AttachmentStore } from './attachment-store.js'
it('recovers pending SQLite state and a durable native file after SIGKILL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-branch-kill-')); const operationId = randomUUID()
  mkdirSync(join(directory, 'project'))
  const timestamp = new Date().toISOString()
  const source = [{ type: 'session', version: 3, id: 'source', cwd: directory, timestamp }, { type: 'message', id: 'u', parentId: null, timestamp, message: { role: 'user', content: 'question', timestamp: Date.now() } }].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  writeFileSync(join(directory, 'project', 'source.jsonl'), source)
  const processResult = await new Promise<{ code: number | null; signal: string | null; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/test-fixtures/branch-crash.ts'), directory, operationId], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk }); child.on('error', reject); child.on('exit', (code, signal) => done({ code, signal, stderr }))
  })
  const db = new WorkspaceDatabase(join(directory, 'db.sqlite')); const index = new PiSessionIndex({ directory, watch: false })
  try {
    expect(processResult.stderr).toBe('')
    expect(processResult.signal).toBe('SIGKILL')
    const store = new SessionBranchStore(db)
    expect(store.pending()).toHaveLength(1)
    const service = new SessionBranchService(store, index, new AttachmentStore(join(directory, 'attachments')))
    await service.recover()
    expect((await service.operation('source', operationId))?.state).toBe('ready')
    expect((await index.list())).toHaveLength(2)
    expect(readFileSync(join(directory, 'project', 'source.jsonl'), 'utf8')).toBe(source)
  } finally { index.close(); db.close(); rmSync(directory, { recursive: true, force: true }) }
}, 10000)
