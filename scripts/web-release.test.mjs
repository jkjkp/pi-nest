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

test('a running release survives stash, split commits, rebuild and a push to a local bare remote', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { mkdir, access } = await import('node:fs/promises')
  const execute = promisify(execFile)
  const directory = await mkdtemp(join(tmpdir(), 'pi-nest-git-workflow-'))
  const source = join(directory, 'checkout')
  const remote = join(directory, 'remote.git')
  let release
  const git = (...args) => execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', source, ...args])
  try {
    await mkdir(source)
    await git('init', '--quiet', '--initial-branch=main')
    await git('config', 'user.name', 'Pi Nest fixture')
    await git('config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(source, 'index.html'), '<main>original</main>')
    await git('add', '.')
    await git('commit', '--quiet', '-m', 'baseline')
    await writeFile(join(source, 'index.html'), '<main>running version</main>')
    await writeFile(join(source, 'new-history-hook.js'), 'export const version = 2')
    release = await stageWebRelease(source)
    await git('stash', 'push', '--quiet', '--include-untracked')
    await assert.rejects(access(join(source, 'new-history-hook.js')))
    await writeFile(join(source, 'notes.md'), 'first split commit')
    await git('add', 'notes.md')
    await git('commit', '--quiet', '-m', 'first change')
    await git('stash', 'pop', '--quiet')
    await writeFile(join(source, 'index.html'), '<main>rebuilt version</main>')
    await git('add', '.')
    await git('commit', '--quiet', '-m', 'second change')
    await execute('git', ['init', '--bare', '--quiet', remote])
    await git('push', '--quiet', remote, 'main')
    assert.equal(await readFile(join(release, 'index.html'), 'utf8'), '<main>running version</main>')
    assert.equal(await readFile(join(release, 'new-history-hook.js'), 'utf8'), 'export const version = 2')
  } finally { await rm(directory, { recursive: true, force: true }); if (release) await rm(release, { recursive: true, force: true }) }
})
