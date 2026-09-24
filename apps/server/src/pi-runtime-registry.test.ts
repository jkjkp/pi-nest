import { describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PiRuntimeHost } from './pi-runtime-host.js'
import { PiRuntimeCapacityError, PiRuntimeRegistry } from './pi-runtime-registry.js'

const session = { cwd: '/fixture', id: 'session-1', sessionFile: '/fixture/session.jsonl' }
const sessionFor = (id: string) => ({ ...session, id })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, reject, resolve }
}

function hostMock() {
  const failures = new Set<(failure: { kind: string; message: string }) => void>()
  const listeners = new Set<(event: { event: Record<string, unknown>; observedAt: string; sessionId: string }) => void>()
  const host = {
    abort: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    onFailure: vi.fn((listener) => { failures.add(listener); return () => failures.delete(listener) }),
    prompt: vi.fn().mockResolvedValue({ model: undefined, stopReason: 'stop' }),
    start: vi.fn().mockResolvedValue({}),
    emit: (event: Record<string, unknown>) => { for (const listener of listeners) listener({ event, observedAt: 'now', sessionId: session.id }) },
    fail: (failure: { kind: string; message: string }) => { for (const listener of failures) listener(failure) },
  }
  return { ...host, beginPrompt: vi.fn((message: string) => ({ accepted: Promise.resolve(), settled: host.prompt(message) })) }
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

  it('evicts the least recently used unwatched idle runtime before exceeding capacity', async () => {
    const first = hostMock()
    const second = hostMock()
    const third = hostMock()
    const createHost = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third)
    const registry = new PiRuntimeRegistry({ createHost: createHost as never, maxLoadedRuntimes: 2 })

    await registry.resume(sessionFor('one'))
    await registry.resume(sessionFor('two'))
    await registry.resume(sessionFor('three'))

    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
    expect(createHost).toHaveBeenCalledTimes(3)
    await registry.close()
  })

  it('does not evict a watched idle runtime and returns an explicit capacity error', async () => {
    const first = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => first as unknown as PiRuntimeHost, maxLoadedRuntimes: 1 })
    await registry.resume(sessionFor('one'))
    await registry.watch('one', 'socket-a', 0, () => undefined, () => undefined)

    await expect(registry.resume(sessionFor('two'))).rejects.toBeInstanceOf(PiRuntimeCapacityError)
    expect(first.close).not.toHaveBeenCalled()
    await registry.close()
  })

  it('serializes concurrent admissions so loading runtimes cannot exceed capacity', async () => {
    const starting = deferred<{}>()
    const first = hostMock()
    first.start.mockReturnValueOnce(starting.promise)
    const registry = new PiRuntimeRegistry({ createHost: () => first as unknown as PiRuntimeHost, maxLoadedRuntimes: 1 })

    const firstResume = registry.resume(sessionFor('one'))
    await vi.waitFor(() => expect(first.start).toHaveBeenCalledOnce())
    await expect(registry.resume(sessionFor('two'))).rejects.toBeInstanceOf(PiRuntimeCapacityError)
    starting.resolve({})
    await firstResume
    await registry.close()
  })

  it('preserves the existing event-cache deadline when LRU evicts a host', async () => {
    vi.useFakeTimers()
    const registry = new PiRuntimeRegistry({
      createHost: () => hostMock() as unknown as PiRuntimeHost,
      maxLoadedRuntimes: 1,
      runtimeUnloadGraceMs: 10,
    })
    await registry.resume(sessionFor('one'))
    await vi.advanceTimersByTimeAsync(5)
    await registry.resume(sessionFor('two'))
    await vi.advanceTimersByTimeAsync(5)

    await expect(registry.watch('one', 'socket-a', 1, () => undefined, () => undefined)).rejects.toMatchObject({ code: 'RESUME_GAP' })
    await registry.close()
    vi.useRealTimers()
  })

  it('broadcasts a classified unexpected host failure and allows explicit recovery', async () => {
    const failed = hostMock()
    const recovered = hostMock()
    const createHost = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(recovered)
    const registry = new PiRuntimeRegistry({ createHost: createHost as never })
    const statuses: Array<{ failureKind?: string; lifecycle: string }> = []
    await registry.watch(session.id, 'socket-a', 0, () => undefined, () => undefined, undefined, (status) => statuses.push(status))
    await registry.resume(session)

    failed.fail({ kind: 'process_exit', message: 'Pi process exited unexpectedly' })
    await vi.waitFor(() => expect(statuses.map((status) => status.lifecycle)).toContain('failed'))
    expect(statuses.find((status) => status.lifecycle === 'failed')).toMatchObject({ failureKind: 'process_exit' })
    expect(failed.close).toHaveBeenCalledOnce()
    await registry.resume(session)
    expect(createHost).toHaveBeenCalledTimes(2)
    await registry.close()
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
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledWith('first'))
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

  it('restores durable extension projection after restart and promotes it on a live update', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-nest-projection-registry-test-'))
    const firstHost = hostMock()
    const first = new PiRuntimeRegistry({ createHost: () => firstHost as unknown as PiRuntimeHost, projectionDirectory: directory })
    await first.resume(session)
    firstHost.emit({ method: 'setStatus', statusKey: 'agent', statusText: 'restored value', type: 'extension_ui_request' })
    await vi.waitFor(() => expect(first.getExtensionUiSnapshot(session.id)).toMatchObject({ freshness: 'known', statuses: { agent: 'restored value' } }))
    await first.close()

    const secondHost = hostMock()
    const second = new PiRuntimeRegistry({ createHost: () => secondHost as unknown as PiRuntimeHost, projectionDirectory: directory })
    const snapshots: any[] = []
    await second.watch(session.id, 'tab-a', 0, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot))
    expect(snapshots[0]).toMatchObject({ extensionUi: { freshness: 'restored', statuses: { agent: 'restored value' } } })

    await second.resume(session)
    secondHost.emit({ method: 'setWidget', type: 'extension_ui_request', widgetKey: 'todo', widgetLines: ['one'] })
    await vi.waitFor(() => expect(second.getExtensionUiSnapshot(session.id)).toMatchObject({ freshness: 'known', widgets: { todo: ['one'] } }))
    await second.close()
  })

  it('clears a durable projection after runtime failure or session deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-nest-projection-registry-test-'))
    const failedHost = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => failedHost as unknown as PiRuntimeHost, projectionDirectory: directory })
    await registry.resume(session)
    failedHost.emit({ method: 'setStatus', statusKey: 'agent', statusText: 'thinking', type: 'extension_ui_request' })
    await vi.waitFor(() => expect(registry.getExtensionUiSnapshot(session.id).freshness).toBe('known'))
    failedHost.fail({ kind: 'process_exit', message: 'Pi process exited unexpectedly' })
    await vi.waitFor(() => expect(registry.getExtensionUiSnapshot(session.id)).toEqual({ freshness: 'known', statuses: {}, widgets: {} }))
    await registry.close()

    const afterFailure = new PiRuntimeRegistry({ projectionDirectory: directory })
    const failureSnapshots: any[] = []
    await afterFailure.watch(session.id, 'tab-a', 0, () => undefined, () => undefined, (snapshot) => failureSnapshots.push(snapshot))
    expect(failureSnapshots[0]?.extensionUi.freshness).toBe('unknown')
    await afterFailure.close()

    const deletingHost = hostMock()
    const deleting = new PiRuntimeRegistry({ createHost: () => deletingHost as unknown as PiRuntimeHost, projectionDirectory: directory })
    await deleting.resume(session)
    deletingHost.emit({ method: 'setStatus', statusKey: 'agent', statusText: 'delete me', type: 'extension_ui_request' })
    await vi.waitFor(() => expect(deleting.getExtensionUiSnapshot(session.id).freshness).toBe('known'))
    await deleting.deleteSession(session.id)
    await deleting.close()

    const afterDelete = new PiRuntimeRegistry({ projectionDirectory: directory })
    const deletionSnapshots: any[] = []
    await afterDelete.watch(session.id, 'tab-a', 0, () => undefined, () => undefined, (snapshot) => deletionSnapshots.push(snapshot))
    expect(deletionSnapshots[0]?.extensionUi.freshness).toBe('unknown')
    await afterDelete.close()
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
