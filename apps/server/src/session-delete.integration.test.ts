import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PiRpcProcess } from '@pi-nest/pi-adapter'
import { PiRuntimeHost } from './pi-runtime-host.js'
import { PiRuntimeRegistry } from './pi-runtime-registry.js'
import { createSessionRoutes } from './session-routes.js'
import { SessionBranchStore } from './session-branch-store.js'
import { WorkspaceDatabase } from './workspace-database.js'
import { createSessionIndexFixture } from './test-fixtures/session-index.js'

it('deletes a real isolated Pi session during startup only after its child exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-delete-real-'))
  const agentDir = join(directory, 'agent')
  await mkdir(agentDir)
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }))
  const session = { id: randomUUID(), cwd: directory, sessionFile: join(directory, 'session.jsonl') }
  await writeFile(session.sessionFile, JSON.stringify({ type: 'session', version: 3, id: session.id, cwd: directory, timestamp: new Date().toISOString() }) + '\n')
  let ready = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let child: ChildProcessWithoutNullStreams | undefined
  const runtime = new PiRuntimeRegistry({
    attachmentDirectory: join(directory, 'attachments'), eventBufferDirectory: join(directory, 'events'), projectionDirectory: join(directory, 'projections'),
    createHost: (binding) => new PiRuntimeHost(binding, () => {
      const rpc = new PiRpcProcess({
        cwd: binding.cwd, expectedSessionId: binding.id, sessionFile: binding.sessionFile,
        spawnProcess: (executable, args, options) => {
          child = spawn(executable, args, { ...options, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } })
          return child
        },
      })
      const start = rpc.start.bind(rpc)
      rpc.start = async () => {
        const state = await start()
        ready = true
        await gate
        return state
      }
      return rpc
    }),
  })
  const database = new WorkspaceDatabase(':memory:')
  const { index } = createSessionIndexFixture([{ ...session, name: undefined, firstMessage: undefined, updatedAt: undefined }])
  const route = createSessionRoutes(runtime, undefined, undefined, index, new SessionBranchStore(database))
  try {
    const loading = runtime.resume(session)!
    await vi.waitFor(() => expect(ready).toBe(true), { timeout: 15_000 })
    const deleting = route.request(`/sessions/${session.id}`, { method: 'DELETE' })
    await vi.waitFor(() => expect(runtime.sessionAccessError(session.id)?.code).toBe('SESSION_DELETING'))
    expect(existsSync(session.sessionFile)).toBe(true)
    expect(child?.exitCode).toBeNull()
    release()
    await loading
    const response = await deleting
    expect(response.status, response.status === 204 ? undefined : await response.text()).toBe(204)
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true)
    expect(existsSync(session.sessionFile)).toBe(false)
    expect(await index.resolve(session.id)).toBeUndefined()
    expect(runtime.resume(session)).toBeUndefined()
    expect((await route.request(`/sessions/${session.id}`, { method: 'DELETE' })).status).toBe(404)
  } finally { release(); database.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }) }
}, 25_000)
