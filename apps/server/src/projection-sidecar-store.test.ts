import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ProjectionSidecarStore } from './projection-sidecar-store.js'

async function directory() {
  return mkdtemp(join(tmpdir(), 'pi-nest-projection-test-'))
}

describe('ProjectionSidecarStore', () => {
  it('atomically saves and restores a bounded projection with private permissions', async () => {
    const path = await directory()
    const now = 1_000_000
    const store = new ProjectionSidecarStore({ directory: path, now: () => now })

    expect(await store.save('session-1', { statuses: { agent: 'thinking' }, widgets: { todo: ['one'] } })).toBe(true)
    const [file] = (await readdir(path)).filter((name) => name.endsWith('.json'))
    expect(file).toBeDefined()
    expect((await stat(path)).mode & 0o777).toBe(0o700)
    expect((await stat(join(path, file!))).mode & 0o777).toBe(0o600)

    const restored = new ProjectionSidecarStore({ directory: path, now: () => now })
    await expect(restored.loadAll()).resolves.toEqual(new Map([['session-1', { statuses: { agent: 'thinking' }, widgets: { todo: ['one'] } }]]))
  })

  it('discards corrupted, expired, and oversized sidecars without throwing', async () => {
    const path = await directory()
    const store = new ProjectionSidecarStore({ directory: path, now: () => 1_000_000 })
    await store.save('session-1', { statuses: { agent: 'old' }, widgets: {} })
    const [file] = (await readdir(path)).filter((name) => name.endsWith('.json'))
    await writeFile(join(path, file!), '{not json')
    await expect(new ProjectionSidecarStore({ directory: path, now: () => 1_000_000 }).loadAll()).resolves.toEqual(new Map())

    await store.save('session-1', { statuses: { agent: 'old' }, widgets: {} })
    await expect(new ProjectionSidecarStore({ directory: path, now: () => 1_000_000 + 31 * 24 * 60 * 60_000 }).loadAll()).resolves.toEqual(new Map())
    expect(await store.save('session-1', { statuses: { agent: 'x'.repeat(64 * 1024) }, widgets: {} })).toBe(false)
    await expect(new ProjectionSidecarStore({ directory: path, now: () => 1_000_000 }).loadAll()).resolves.toEqual(new Map())
  })

  it('removes the sidecar on request', async () => {
    const path = await directory()
    const store = new ProjectionSidecarStore({ directory: path })
    await store.save('session-1', { statuses: {}, widgets: {} })
    expect(await store.delete('session-1')).toBe(true)
    await expect(new ProjectionSidecarStore({ directory: path }).loadAll()).resolves.toEqual(new Map())
  })
})
