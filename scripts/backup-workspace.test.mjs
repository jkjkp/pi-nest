import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { backupWorkspace } from './backup-workspace.mjs'
const Database = createRequire(new URL('../apps/server/package.json', import.meta.url))('better-sqlite3')
test('online backup restores data and never overwrites an existing target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-backup-'))
  const source = join(dir, 'source.sqlite'); const target = join(dir, 'backup.sqlite')
  const db = new Database(source)
  try {
    db.pragma('journal_mode=WAL'); db.exec("CREATE TABLE proof(value); INSERT INTO proof VALUES ('saved')")
    await backupWorkspace(source, target)
    const restored = new Database(target, { readonly: true })
    assert.equal(restored.prepare('SELECT value FROM proof').get().value, 'saved'); restored.close()
    await assert.rejects(backupWorkspace(source, target), /已存在/)
    await assert.rejects(backupWorkspace(source, source), /覆盖/)
  } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})
