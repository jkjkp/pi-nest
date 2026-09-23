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
    start: vi.fn().mockResolvedValue({}),
    emit: (event: Record<string, unknown>) => { for (const listener of listeners) listener({ event, observedAt: 'now', sessionId: session.id }) },
  }
}

describe('PiRuntimeRegistry', () => {
  it('watches a cold session without creating a Pi host, and only resume creates it', async () => {
    const host = hostMock()
    const createHost = vi.fn(() => host as unknown as PiRuntimeHost)
    const registry = new PiRuntimeRegistry({ createHost })

    await registry.watch(session.id, 'tab-a', 0, () => undefined, () => undefined)
    expect(createHost).not.toHaveBeenCalled()
    await registry.resume(session)
    expect(createHost).toHaveBeenCalledOnce()
    expect(host.start).toHaveBeenCalledOnce()
    await registry.close()
  })

  it('rejects an invalid runtime unload grace configuration at startup', () => {
    const previous = process.env.PI_NEST_RUNTIME_UNLOAD_GRACE_MS
    process.env.PI_NEST_RUNTIME_UNLOAD_GRACE_MS = '0'
    expect(() => new PiRuntimeRegistry()).toThrow('PI_NEST_RUNTIME_UNLOAD_GRACE_MS must be a positive integer')
    if (previous === undefined) delete process.env.PI_NEST_RUNTIME_UNLOAD_GRACE_MS
    else process.env.PI_NEST_RUNTIME_UNLOAD_GRACE_MS = previous
  })

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
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost, runtimeUnloadGraceMs: 10 })
    await registry.startPrompt(session, 'done')

    await vi.advanceTimersByTimeAsync(10)
    expect(host.close).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('keeps an idle runtime loaded while another socket is still watching', async () => {
    vi.useFakeTimers()
    const host = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost, runtimeUnloadGraceMs: 10 })
    await registry.startPrompt(session, 'done')
    await registry.watch(session.id, 'socket-a', 0, () => undefined, () => undefined)
    await registry.watch(session.id, 'socket-b', 0, () => undefined, () => undefined)

    expect(registry.unwatch(session.id, 'socket-a')).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(host.close).not.toHaveBeenCalled()
    expect(registry.unwatch(session.id, 'socket-b')).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(host.close).toHaveBeenCalledOnce()
    await registry.close()
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

  it('captures per-key extension projection at the same sequence boundary as replay', async () => {
    const host = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    const snapshots: any[] = []
    const replayed: number[] = []
    await registry.subscribe(session.id, 0, (event) => replayed.push(event.sequence), () => undefined, (snapshot) => snapshots.push(snapshot))
    await registry.startPrompt(session, 'start')

    host.emit({ method: 'setStatus', statusKey: 'agent', statusText: 'thinking', type: 'extension_ui_request' })
    host.emit({ method: 'setWidget', type: 'extension_ui_request', widgetKey: 'todo', widgetLines: ['one', 'two'] })
    host.emit({ method: 'setStatus', statusKey: '', statusText: 'ignored', type: 'extension_ui_request' })
    await vi.waitFor(() => expect(replayed).toEqual([1, 2, 3]))

    const secondReplay: number[] = []
    await registry.subscribe(session.id, 0, (event) => secondReplay.push(event.sequence), () => undefined, (snapshot) => snapshots.push(snapshot))
    expect(snapshots[0]).toMatchObject({ atSequence: 0, extensionUi: { freshness: 'unknown', statuses: {}, widgets: {} } })
    expect(snapshots[1]).toMatchObject({ atSequence: 3, extensionUi: { freshness: 'known', statuses: { agent: 'thinking' }, widgets: { todo: ['one', 'two'] } } })
    expect(secondReplay).toEqual([1, 2, 3])
    const copied = registry.getExtensionUiSnapshot(session.id)
    copied.widgets.todo?.push('local mutation')
    expect(registry.getExtensionUiSnapshot(session.id).widgets.todo).toEqual(['one', 'two'])

    host.emit({ method: 'setStatus', statusKey: 'agent', type: 'extension_ui_request' })
    host.emit({ method: 'setWidget', type: 'extension_ui_request', widgetKey: 'todo', widgetLines: [1] })
    await vi.waitFor(() => expect(replayed).toEqual([1, 2, 3, 4, 5]))
    const afterDelete: any[] = []
    await registry.subscribe(session.id, 5, () => undefined, () => undefined, (snapshot) => afterDelete.push(snapshot))
    expect(afterDelete[0]?.extensionUi).toEqual({ freshness: 'known', statuses: {}, widgets: {} })
    await registry.close()
  })

  it('broadcasts failed then notLoaded, clearing projection while idle expiry preserves it', async () => {
    const failed = hostMock()
    failed.prompt.mockResolvedValueOnce({ model: undefined, stopReason: 'stop' }).mockRejectedValueOnce(new Error('broken RPC'))
    const registry = new PiRuntimeRegistry({ createHost: () => failed as unknown as PiRuntimeHost, runtimeUnloadGraceMs: 10 })
    const statuses: string[] = []
    const events: number[] = []
    await registry.subscribe(session.id, 0, (event) => events.push(event.sequence), () => undefined, undefined, (status) => statuses.push(status.lifecycle))
    await registry.startPrompt(session, 'start')
    failed.emit({ method: 'setStatus', statusKey: 'agent', statusText: 'thinking', type: 'extension_ui_request' })
    await vi.waitFor(() => expect(events).toEqual([1]))
    await expect(registry.startPrompt(session, 'first')).rejects.toThrow('broken RPC')
    expect(statuses).toContain('failed')
    expect(statuses.slice(-1)).toEqual(['notLoaded'])

    const snapshots: any[] = []
    await registry.subscribe(session.id, 1, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot))
    expect(snapshots[0]?.extensionUi).toEqual({ freshness: 'known', statuses: {}, widgets: {} })
    await registry.close()
  })

  it('expires the host and replay cache together after the last watcher leaves', async () => {
    vi.useFakeTimers()
    const first = hostMock()
    const second = hostMock()
    const createHost = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const registry = new PiRuntimeRegistry({ createHost: createHost as never, runtimeUnloadGraceMs: 10 })
    const received: number[] = []
    const unsubscribe = await registry.watch(session.id, 'tab-a', 0, (event) => received.push(event.sequence), () => undefined)

    await registry.startPrompt(session, 'first')
    first.emit({ type: 'first' })
    await vi.waitFor(() => expect(received).toEqual([1]))
    unsubscribe()
    await vi.advanceTimersByTimeAsync(10)
    expect(first.close).toHaveBeenCalledOnce()
    await expect(registry.watch(session.id, 'tab-b', 1, () => undefined, () => undefined)).rejects.toMatchObject({ code: 'RESUME_GAP' })

    const recreated: number[] = []
    await registry.watch(session.id, 'tab-b', 0, (event) => recreated.push(event.sequence), () => undefined)
    await registry.startPrompt(session, 'second')
    second.emit({ type: 'second' })
    await vi.waitFor(() => expect(recreated).toEqual([1]))
    await registry.close()
    vi.useRealTimers()
  })

  it('keeps daemon projection through the existing idle unload', async () => {
    vi.useFakeTimers()
    const first = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => first as unknown as PiRuntimeHost, runtimeUnloadGraceMs: 10 })
    const received: number[] = []
    const unsubscribe = await registry.watch(session.id, 'tab-a', 0, (event) => received.push(event.sequence), () => undefined)
    await registry.startPrompt(session, 'first')
    first.emit({ method: 'setStatus', statusKey: 'agent', statusText: 'waiting', type: 'extension_ui_request' })
    await vi.waitFor(() => expect(received).toEqual([1]))
    unsubscribe()
    await vi.advanceTimersByTimeAsync(10)

    const snapshots: any[] = []
    await registry.watch(session.id, 'tab-b', 0, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot))
    expect(snapshots[0]).toMatchObject({ extensionUi: { freshness: 'known', statuses: { agent: 'waiting' } }, runtime: { lifecycle: 'notLoaded' } })
    await registry.close()
    vi.useRealTimers()
  })

  it('rejects a stale resume cursor after an unsubscribed stream expires', async () => {
    vi.useFakeTimers()
    const registry = new PiRuntimeRegistry({ runtimeUnloadGraceMs: 10 })
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
