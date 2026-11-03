import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { capturePiSessionHistory } from '@pi-nest/pi-adapter'
import { WorkspaceDatabase } from './workspace-database.js'
import { SessionBranchStore } from './session-branch-store.js'
import { SessionBranchService } from './session-branch-service.js'
import { AttachmentStore } from './attachment-store.js'
import { createSessionIndexFixture } from './test-fixtures/session-index.js'
import { resolveSessionLineage } from './session-lineage.js'
let directory: string
let database: WorkspaceDatabase
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'pi-branch-service-')); database = new WorkspaceDatabase(join(directory, 'db.sqlite')) })
afterEach(() => { vi.restoreAllMocks(); database.close(); rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const file = join(directory, 'source.jsonl')
  const timestamp = new Date().toISOString()
  writeFileSync(file, [
    { type: 'session', version: 3, id: 'source', cwd: directory, timestamp },
    { type: 'message', id: 'a', parentId: null, timestamp, message: { role: 'user', content: 'first', timestamp: Date.now() } },
    { type: 'message', id: 'b', parentId: 'a', timestamp, message: { role: 'user', content: 'edit this', timestamp: Date.now() } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const source = { id: 'source', cwd: directory, sessionFile: file }
  const index = createSessionIndexFixture([{ ...source, name: undefined, firstMessage: 'first', updatedAt: timestamp }])
  const store = new SessionBranchStore(database)
  const attachments = new AttachmentStore(join(directory, 'attachments'))
  const service = new SessionBranchService(store, index.index, attachments)
  const request = { kind: 'fork' as const, mode: 'edit' as const, entryId: 'b', revision: capturePiSessionHistory({ ...source, expectedSessionId: source.id }).revision, operationId: randomUUID() }
  return { source, index, store, service, request, attachments }
}
it('keeps a stable operation, detects conflicting reuse and survives reopening with a missing parent', async () => {
  const { source, index, store, service, request } = fixture()
  const before = readFileSync(source.sessionFile)
  const result = service.create(source, request, undefined, {})
  expect(result).toMatchObject({ draft: 'edit this', operationId: request.operationId, session: { branch: { mode: 'edit', state: 'ready', inheritedLeafId: 'a' } } })
  expect((await service.operation('source', request.operationId, request))?.result).toMatchObject({ draft: 'edit this' })
  await expect(service.operation('source', request.operationId, { ...request, entryId: 'a' })).rejects.toThrow('标识')
  expect(readFileSync(source.sessionFile)).toEqual(before)
  const relation = [...store.relations().values()][0]
  database.close(); database = new WorkspaceDatabase(join(directory, 'db.sqlite'))
  const reopened = new SessionBranchStore(database)
  expect(reopened.operation(request.operationId)).toEqual(relation)
  index.index.forget('source')
  expect(resolveSessionLineage(await index.index.list(), reopened.relations())[0]).toMatchObject({ parentSessionMissing: true, branch: { issue: 'missing' } })
})
it('does not publish a child if pending persistence fails', () => {
  const { source, store, service, request } = fixture()
  vi.spyOn(store, 'prepare').mockImplementationOnce(() => { throw new Error('disk full') })
  expect(() => service.create(source, request, undefined, {})).toThrow('disk full')
  expect(readdirSync(directory).filter((file) => file.endsWith('.jsonl'))).toEqual(['source.jsonl'])
})
it('recovers a published child after attachment failure without creating another child', async () => {
  const { source, index, store, service, request, attachments } = fixture()
  vi.spyOn(attachments, 'inherit').mockImplementationOnce(() => { throw new Error('interrupted') })
  expect(service.create(source, request, undefined, {})).toEqual({ operationId: request.operationId, state: 'pending' })
  expect(store.pending()).toHaveLength(1)
  await service.recover()
  expect((await service.operation('source', request.operationId))?.result?.draft).toBe('edit this')
  expect((await index.index.list())).toHaveLength(2)
  expect(store.pending()).toHaveLength(0)
})
it('marks a changed inherited prefix as attention and preserves its bytes', async () => {
  const { source, store, service, request, attachments, index } = fixture()
  vi.spyOn(attachments, 'inherit').mockImplementationOnce(() => { throw new Error('interrupted') })
  service.create(source, request, undefined, {})
  const child = await index.index.resolve(store.pending()[0].child_session_id)
  const bytes = readFileSync(child!.sessionFile, 'utf8').replace('first', 'other')
  writeFileSync(child!.sessionFile, bytes)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await service.recover()
  expect(store.operation(request.operationId)?.state).toBe('attention')
  expect(readFileSync(child!.sessionFile, 'utf8')).toBe(bytes)
})
it('uses exact native lineage and isolates conflicts and cycles', async () => {
  const { source, store, service, request, index } = fixture()
  service.create(source, request, undefined, {})
  const rows = store.relations()
  const child = [...rows.values()][0]
  expect(resolveSessionLineage(await index.index.list(), rows)[1].branch?.issue).toBeUndefined()
  rows.set(child.child_session_id, { ...child, cwd: '/elsewhere' })
  expect(resolveSessionLineage(await index.index.list(), rows)[1].branch?.issue).toBe('conflict')
  rows.set(child.child_session_id, child)
  rows.set('source', { ...child, child_session_id: 'source', parent_session_id: child.child_session_id })
  expect(resolveSessionLineage(await index.index.list(), rows).every((session) => session.branch?.issue === 'cycle')).toBe(true)
})
