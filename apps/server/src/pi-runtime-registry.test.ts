import { describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PiRuntimeHost } from './pi-runtime-host.js'
import { PiRuntimeRegistry } from './pi-runtime-registry.js'

const session = { cwd: '/fixture', id: 'session-1', sessionFile: '/fixture/session.jsonl' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, reject, resolve }
}

function hostMock() {
  const listeners = new Set<(event: { event: Record<string, unknown>; observedAt: string; sessionId: string }) => void>()
  return {
    abort: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    prompt: vi.fn().mockResolvedValue({ model: undefined, stopReason: 'stop' }),
    emit: (event: Record<string, unknown>) => { for (const listener of listeners) listener({ event, observedAt: 'now', sessionId: session.id }) },
  }
}

describe('PiRuntimeRegistry', () => {
  it('enforces one prompt or mutation per native session and releases the prompt lock', async () => {
    const host = hostMock()
    const running = deferred<{ model: undefined; stopReason: string }>()
    host.prompt.mockReturnValueOnce(running.promise)
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })

    const first = registry.startPrompt(session, 'first')
    expect(first).toBeDefined()
    expect(registry.startPrompt(session, 'second')).toBeUndefined()
    expect(registry.beginMutation(session.id)).toBeUndefined()
    expect(await registry.abort(session.id)).toBe(true)

    running.resolve({ model: undefined, stopReason: 'stop' })
    await expect(first).resolves.toMatchObject({ stopReason: 'stop' })
    const mutation = registry.beginMutation(session.id)
    expect(mutation).toBeDefined()
    const finish = await mutation
    finish?.()
    await registry.close()
  })

  it('closes an idle host after its configured retention window', async () => {
    vi.useFakeTimers()
    const host = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost, idleTimeoutMs: 10 })
    await registry.startPrompt(session, 'done')

    await vi.advanceTimersByTimeAsync(10)
    expect(host.close).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('drops a failed host so a later prompt receives a clean runtime', async () => {
    const failed = hostMock()
    failed.prompt.mockRejectedValueOnce(new Error('broken RPC'))
    const recovered = hostMock()
    const createHost = vi.fn()
      .mockReturnValueOnce(failed as unknown as PiRuntimeHost)
      .mockReturnValueOnce(recovered as unknown as PiRuntimeHost)
    const registry = new PiRuntimeRegistry({ createHost })

    await expect(registry.startPrompt(session, 'first')).rejects.toThrow('broken RPC')
    await expect(registry.startPrompt(session, 'second')).resolves.toMatchObject({ stopReason: 'stop' })
    expect(failed.close).toHaveBeenCalledOnce()
    expect(createHost).toHaveBeenCalledTimes(2)
    await registry.close()
  })

  it('keeps sequence and replay records when an idle host is recreated', async () => {
    vi.useFakeTimers()
    const first = hostMock()
    const second = hostMock()
    const createHost = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const registry = new PiRuntimeRegistry({ createHost: createHost as never, eventRetentionMs: 100, idleTimeoutMs: 10 })
    const received: number[] = []
    const unsubscribe = await registry.subscribe(session.id, 0, (event) => received.push(event.sequence), () => undefined)

    await registry.startPrompt(session, 'first')
    first.emit({ type: 'first' })
    await vi.waitFor(() => expect(received).toEqual([1]))
    await vi.advanceTimersByTimeAsync(10)
    await registry.startPrompt(session, 'second')
    second.emit({ type: 'second' })
    await vi.waitFor(() => expect(received).toEqual([1, 2]))

    const replayed: number[] = []
    await registry.subscribe(session.id, 1, (event) => replayed.push(event.sequence), () => undefined)
    expect(replayed).toEqual([2])
    unsubscribe()
    await registry.close()
    vi.useRealTimers()
  })

  it('rejects a stale resume cursor after an unsubscribed stream expires', async () => {
    vi.useFakeTimers()
    const registry = new PiRuntimeRegistry({ eventRetentionMs: 10 })
    const unsubscribe = await registry.subscribe(session.id, 0, () => undefined, () => undefined)
    unsubscribe()
    await vi.advanceTimersByTimeAsync(10)
    await expect(registry.subscribe(session.id, 1, () => undefined, () => undefined)).rejects.toMatchObject({ code: 'RESUME_GAP' })
    await registry.close()
    vi.useRealTimers()
  })

  it('restricts the temporary event directory and JSONL file permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-nest-registry-test-'))
    await chmod(directory, 0o755)
    const host = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost, eventBufferDirectory: directory })
    await registry.subscribe(session.id, 0, () => undefined, () => undefined)
    await registry.startPrompt(session, 'prompt')
    host.emit({ type: 'event' })
    await vi.waitFor(async () => expect(await readdir(directory)).toHaveLength(1))
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    const [file] = await readdir(directory)
    expect((await stat(join(directory, file!))).mode & 0o777).toBe(0o600)
    await registry.close()
  })
})
