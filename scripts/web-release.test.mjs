import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageWebRelease } from './web-release.mjs'

test('running web release survives source checkout, rebuild and deletion', async () => {
  const source = await mkdtemp(join(tmpdir(), 'pi-nest-source-'))
  let release
  try {
    await writeFile(join(source, 'index.html'), 'version one')
    release = await stageWebRelease(source)
    await writeFile(join(source, 'index.html'), 'version two')
    await rm(source, { recursive: true, force: true })
    assert.equal(await readFile(join(release, 'index.html'), 'utf8'), 'version one')
    assert.equal((await stat(release)).mode & 0o777, 0o700)
  } finally { await rm(source, { recursive: true, force: true }); if (release) await rm(release, { recursive: true, force: true }) }
})
