import { describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiRpcCommandError } from '@pi-nest/pi-adapter'
import type { PiRuntimeEvent, PiRuntimeHost } from './pi-runtime-host.js'
import { PiRuntimeBusyError, PiRuntimeCapacityError, PiRuntimeRegistry } from './pi-runtime-registry.js'

vi.mock('@pi-nest/pi-adapter', async (original) => ({ ...await original<typeof import('@pi-nest/pi-adapter')>(), capturePiSessionHistory: vi.fn(() => ({ entries: [], revision: 'a'.repeat(64), bytes: 1 })) }))

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
    respondToExtension: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue({}),
    emit: (event: Record<string, unknown>) => { for (const listener of listeners) listener({ event, observedAt: 'now', sessionId: session.id }) },
    fail: (failure: { kind: string; message: string }) => { for (const listener of failures) listener(failure) },
  }
  return { ...host, beginPrompt: vi.fn((message: string) => ({ accepted: Promise.resolve(), settled: host.prompt(message) })) }
}

describe('PiRuntimeRegistry', () => {
  it('promotes only the chosen queued message and preserves the queue if steering fails', async () => {
    const host = { ...hostMock(), command: vi.fn().mockResolvedValue({ success: true }) }
    host.prompt.mockImplementation(() => new Promise(() => {}))
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    try {
      await registry.beginPrompt(session, 'first')!.accepted
      await registry.commandWhileRunning(session.id, { type: 'follow_up', message: 'later' })
      await registry.commandWhileRunning(session.id, { type: 'follow_up', message: 'next' })
      await registry.commandWhileRunning(session.id, { type: 'steer_queued', index: 1, message: 'next' })
      expect(host.command).toHaveBeenCalledWith({ type: 'steer', message: 'next' })
      const snapshots: any[] = []
      const unwatch = await registry.watch(session.id, 'tab', 0, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot))
      expect(snapshots.at(-1).inputQueue.followUp).toEqual(['later'])
      unwatch()
      host.command.mockRejectedValueOnce(new Error('rejected'))
      await expect(registry.commandWhileRunning(session.id, { type: 'steer_queued', index: 0, message: 'later' })).rejects.toThrow('rejected')
      const unwatchAgain = await registry.watch(session.id, 'tab', 0, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot))
      expect(snapshots.at(-1).inputQueue.followUp).toEqual(['later'])
      await expect(registry.commandWhileRunning(session.id, { type: 'steer_queued', index: 0, message: 'stale' })).rejects.toThrow('changed')
      unwatchAgain()
    } finally { await registry.close() }
  })

  it('starts queued prompts in order only after the preceding run settles', async () => {
    const host = hostMock()
    let finish!: (result: { model: undefined; stopReason: string }) => void
    host.prompt.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve })).mockImplementation(() => new Promise(() => {}))
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    try {
      const prompt = registry.beginPrompt(session, 'first')!
      await prompt.accepted
      await registry.commandWhileRunning(session.id, { type: 'follow_up', message: 'second' })
      await registry.commandWhileRunning(session.id, { type: 'follow_up', message: 'third' })
      expect(host.prompt).toHaveBeenCalledTimes(1)
      finish({ model: undefined, stopReason: 'stop' })
      await prompt.settled
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2))
      expect(host.prompt.mock.calls.map(([message]) => message)).toEqual(['first', 'second'])
      const snapshots: any[] = []
      const unwatch = await registry.watch(session.id, 'tab', 0, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot))
      expect(snapshots.at(-1).inputQueue.followUp).toEqual(['third'])
      unwatch()
    } finally { await registry.close() }
  })
  it('restores the real input queue in a reconnect snapshot without sending queued prompts early', async () => {
    const host = { ...hostMock(), command: vi.fn().mockResolvedValue({ success: true }) }
    host.prompt.mockImplementation(() => new Promise(() => {}))
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    try {
      await registry.beginPrompt(session, 'first')!.accepted
      await registry.commandWhileRunning(session.id, { type: 'follow_up', message: 'later' })
      expect(host.command).not.toHaveBeenCalled()
      host.emit({ type: 'queue_update', steering: ['change direction'], followUp: ['later', 'next'] })
      const snapshots: any[] = []
      const unwatch = await registry.watch(session.id, 'reconnected', 0, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot))
      expect(snapshots.at(-1).inputQueue).toEqual({ steering: ['change direction'], followUp: ['later', 'next', 'later'] })
      unwatch()
    } finally { await registry.close() }
  })
  it('publishes completion for a handled prompt without inventing a native settlement event', async () => {
    const host = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    try {
      const statuses: any[] = [], events: PiRuntimeEvent[] = []
      await registry.watch(session.id, 'tab', 0, (event) => events.push(event), () => undefined, undefined, (status) => statuses.push(status))
      const prompt = registry.beginPrompt(session, '/extension-command')!
      await prompt.settled
      expect(statuses.at(-1)).toMatchObject({ lifecycle: 'idle', completedRun: { runId: prompt.runId, stopReason: 'stop' } })
      expect(events).toHaveLength(0)
    } finally { await registry.close() }
  })

  it('retains an upstream abort in a native-run completion snapshot without an assistant message', async () => {
    const host = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    try {
      await registry.resume(session)
      host.emit({ type: 'agent_start' })
      host.emit({ type: 'agent_settled', aborted: true })
      const snapshots: any[] = []
      const unwatch = await registry.watch(session.id, 'reconnected', 0, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot))
      expect(snapshots.at(-1)).toMatchObject({ runtime: { lifecycle: 'idle' }, completedRun: { stopReason: 'aborted' } })
      unwatch()
    } finally { await registry.close() }
  })

  it.each(['stop', 'error', 'aborted'])('exposes the last completion in an idle snapshot without replaying old events: %s', async (stopReason) => {
    const running = deferred<{ model: undefined; stopReason: string }>()
    const host = hostMock()
    host.prompt.mockReturnValueOnce(running.promise)
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    try {
      const delivered: PiRuntimeEvent[] = [], statuses: any[] = []
      const initialWatch = await registry.watch(session.id, 'initial', 0, (event) => delivered.push(event), () => undefined, undefined, (status) => statuses.push(status))
      const prompt = registry.beginPrompt(session, 'hello')!
      await prompt.accepted
      if (stopReason === 'aborted') await registry.abort(session.id)
      else host.emit({ type: 'message_end', message: { role: 'assistant', stopReason } })
      host.emit({ type: 'agent_settled' })
      running.resolve({ model: undefined, stopReason })
      await prompt.settled
      expect(statuses.at(-1)).toMatchObject({ lifecycle: 'idle' })
      await vi.waitFor(() => expect(delivered.at(-1)?.event.type).toBe('agent_settled'))
      initialWatch()
      const snapshots: any[] = [], events: PiRuntimeEvent[] = []
      const unwatch = await registry.watch(session.id, 'reconnected', 0, (event) => events.push(event), () => undefined, (snapshot) => snapshots.push(snapshot))
      expect(snapshots.at(-1)).toMatchObject({ runtime: { lifecycle: 'idle' }, completedRun: { runId: prompt.runId, stopReason } })
      expect(events).toHaveLength(0)
      unwatch()
    } finally { running.resolve({ model: undefined, stopReason }); await registry.close() }
  })

  it('includes the cached model in status and snapshots while a prompt is active', async () => {
    const running = deferred<{ model: undefined; stopReason: string }>()
    const host = { ...hostMock(), currentModel: { provider: 'test', id: 'chosen' }, currentThinkingLevel: 'high', prompt: vi.fn(() => running.promise) }
    host.beginPrompt = vi.fn(() => ({ accepted: Promise.resolve(), settled: running.promise }))
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    const statuses: any[] = [], snapshots: any[] = []
    try {
      const watch = await registry.watch(session.id, 'first', 0, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot), (status) => statuses.push(status))
      await registry.resume(session)
      expect(statuses.at(-1)?.model?.id).toBe('chosen')
      expect(statuses.at(-1)?.thinkingLevel).toBe('high')
      const prompt = registry.beginPrompt(session, 'hello')!
      await prompt.accepted
      const activeWatch = await registry.watch(session.id, 'second', 0, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot))
      expect(snapshots.at(-1)?.runtime).toMatchObject({ lifecycle: 'active', thinkingLevel: 'high', model: { provider: 'test', id: 'chosen' } })
      activeWatch()
      watch()
      running.resolve({ model: undefined, stopReason: 'stop' })
      await prompt.settled
    } finally { running.resolve({ model: undefined, stopReason: 'stop' }); await registry.close() }
  })

  it('reports missing runtimes separately from locked control commands and settings updates', async () => {
    const result = deferred<Record<string, unknown>>()
    const host = { ...hostMock(), command: vi.fn(() => result.promise) }
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    try {
      expect(registry.commandWhenIdle(session, { type: 'get_runtime_state' })).toBeUndefined()
      await registry.resume(session)
      const first = registry.commandWhenIdle(session, { type: 'get_runtime_state' })!
      expect(() => registry.commandWhenIdle(session, { type: 'get_available_models' })).toThrow(PiRuntimeBusyError)
      result.resolve({ data: {} })
      await first
      const finishSettings = registry.beginGlobalSettingsUpdate()!
      expect(() => registry.commandWhenIdle(session, { type: 'get_runtime_state' })).toThrow(PiRuntimeBusyError)
      await finishSettings()
      await expect(registry.commandWhenIdle(session, { type: 'get_available_models' })).resolves.toEqual({ data: {} })
    } finally {
      result.resolve({ data: {} })
      await registry.close()
    }
  })

  it('keeps a loaded runtime usable when Pi rejects a control command', async () => {
    const host = { ...hostMock(), command: vi.fn().mockRejectedValueOnce(new PiRpcCommandError('Model not found')).mockResolvedValue({ data: { model: { id: 'original' } } }) }
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    try {
      await registry.resume(session)
      await expect(registry.commandWhenIdle(session, { type: 'set_model' })).rejects.toThrow('Model not found')
      expect(host.close).not.toHaveBeenCalled()
      await expect(registry.commandWhenIdle(session, { type: 'get_runtime_state' })).resolves.toMatchObject({ data: { model: { id: 'original' } } })
    } finally { await registry.close() }
  })

  it('tags native events with the prompt run ID before asynchronous stream delivery', async () => {
    const host = hostMock()
    const running = deferred<{ model: undefined; stopReason: string }>()
    host.prompt.mockReturnValueOnce(running.promise)
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    const events: Array<{ runId?: string }> = []
    await registry.subscribe(session.id, 0, (event) => events.push(event), () => undefined)

    const prompt = registry.beginPrompt(session, 'implement')!
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledWith('implement'))
    host.emit({ type: 'turn_start' })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]?.runId).toBe(prompt.runId)

    running.resolve({ model: undefined, stopReason: 'stop' })
    await prompt.settled
    await registry.close()
  })

  it('accepts one pending extension response after the prompt has settled', async () => {
    const host = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    const events: number[] = []
    await registry.subscribe(session.id, 0, (event) => events.push(event.sequence), () => undefined)
    await registry.startPrompt(session, 'make a plan')
    host.emit({ id: 'plan-choice', method: 'select', options: ['Implement here'], title: 'Plan ready', type: 'extension_ui_request' })
    await vi.waitFor(() => expect(events).toEqual([1]))

    await expect(registry.respondToExtension(session.id, { id: 'plan-choice', type: 'extension_ui_response', value: 'Implement here' })).resolves.toBe(true)
    expect(host.respondToExtension).toHaveBeenCalledWith({ id: 'plan-choice', type: 'extension_ui_response', value: 'Implement here' })
    await expect(registry.respondToExtension(session.id, { id: 'plan-choice', type: 'extension_ui_response', value: 'Implement here' })).resolves.toBe(false)
    await registry.close()
  })

  it('snapshots an idle pending dialog without replaying its historical request', async () => {
    const host = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    await registry.resume(session)
    const received: PiRuntimeEvent[] = []
    await registry.watch(session.id, 'tab-live', 0, (event) => received.push(event), () => undefined)
    host.emit({ id: 'choice-1', method: 'select', options: ['one'], title: 'Choose', type: 'extension_ui_request' })
    await vi.waitFor(() => expect(received).toHaveLength(1))

    const replayed: PiRuntimeEvent[] = []
    const snapshots: any[] = []
    await registry.watch(session.id, 'tab-a', 0, (event) => replayed.push(event), () => undefined, (snapshot) => snapshots.push(snapshot))

    expect(replayed).toEqual([])
    expect(snapshots[0]?.pendingExtensionDialogs).toMatchObject([{ event: { id: 'choice-1', type: 'extension_ui_request' } }])

    await registry.respondToExtension(session.id, { id: 'choice-1', type: 'extension_ui_response', value: 'one' })
    await vi.waitFor(() => expect(replayed).toContainEqual(expect.objectContaining({ event: { dialogId: 'choice-1', type: 'extension_ui_resolved' } })))
    await registry.close()
  })

  it('does not replay thought events while an active turn waits for extension input', async () => {
    const host = hostMock()
    const running = deferred<{ model: undefined; stopReason: string }>()
    host.prompt.mockReturnValueOnce(running.promise)
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    await registry.watch(session.id, 'live', 0, () => undefined, () => undefined)
    registry.beginPrompt(session, 'make a plan')
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalled())
    host.emit({ type: 'turn_start' })
    host.emit({ assistantMessageEvent: { delta: 'thinking', type: 'thinking_delta' }, type: 'message_update' })
    host.emit({ id: 'choice-1', method: 'select', options: ['one'], title: 'Choose', type: 'extension_ui_request' })
    await vi.waitFor(() => expect(registry.isPromptStreaming(session.id)).toBe(false))

    const replayed: number[] = []
    const snapshots: any[] = []
    await registry.watch(session.id, 'refreshed', 0, (event) => replayed.push(event.sequence), () => undefined, (snapshot) => snapshots.push(snapshot))

    expect(replayed).toEqual([])
    expect(snapshots[0]).toMatchObject({ activeTurn: { waitingForExtension: true }, pendingExtensionDialogs: [{ event: { id: 'choice-1' } }] })

    await registry.respondToExtension(session.id, { id: 'choice-1', type: 'extension_ui_response', value: 'one' })
    host.emit({ type: 'agent_start' })
    host.emit({ assistantMessageEvent: { delta: 'new thought', type: 'thinking_delta' }, type: 'message_update' })
    await vi.waitFor(() => expect(registry.isPromptStreaming(session.id)).toBe(true))

    const resumed: number[] = []
    await registry.watch(session.id, 'resumed', 0, (event) => resumed.push(event.sequence), () => undefined)
    expect(resumed).toEqual([5, 6])
    await registry.close()
  })

  it('tracks an agent started by Pi after an extension response as a native active turn', async () => {
    const host = hostMock()
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    const events: Array<{ runId?: string }> = []
    const statuses: string[] = []
    await registry.watch(session.id, 'tab-a', 0, (event) => events.push(event), () => undefined, undefined, (status) => statuses.push(status.lifecycle))
    await registry.resume(session)

    host.emit({ type: 'agent_start' })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const runId = events[0]?.runId
    expect(runId).toBeTypeOf('string')
    expect(registry.isPromptActive(session.id)).toBe(true)
    expect(registry.beginPrompt(session, 'must wait')).toBeUndefined()

    const snapshots: any[] = []
    await registry.watch(session.id, 'tab-b', 1, () => undefined, () => undefined, (snapshot) => snapshots.push(snapshot))
    expect(snapshots[0]).toMatchObject({ activeTurn: { runId }, runtime: { lifecycle: 'active' } })
    expect(snapshots[0]?.activeTurn?.prompt).toBeUndefined()

    host.emit({ message: { content: 'Implement the plan.', role: 'user' }, type: 'message' })
    host.emit({ type: 'agent_settled' })
    await vi.waitFor(() => expect(events).toHaveLength(3))
    expect(events.map((event) => event.runId)).toEqual([runId, runId, runId])
    expect(statuses).toContain('active')
    expect(statuses).toContain('idle')
    expect(registry.isPromptActive(session.id)).toBe(false)
    await registry.close()
  })

  it('does not let a settled plan turn consume its immediately started implementation turn', async () => {
    const host = hostMock()
    const running = deferred<{ model: undefined; stopReason: string }>()
    host.prompt.mockReturnValueOnce(running.promise)
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    const events: Array<{ runId?: string }> = []
    await registry.watch(session.id, 'tab-a', 0, (event) => events.push(event), () => undefined)

    const plan = registry.beginPrompt(session, 'make a plan')!
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledWith('make a plan'))
    host.emit({ type: 'agent_settled' })
    host.emit({ type: 'agent_start' })
    host.emit({ type: 'turn_start' })
    host.emit({ message: { content: [{ text: 'Implement the plan.', type: 'text' }], role: 'user' }, type: 'message_start' })
    await vi.waitFor(() => expect(events).toHaveLength(4))

    const implementationRunId = events[1]?.runId
    expect(events.map((event) => event.runId)).toEqual([plan.runId, implementationRunId, implementationRunId, implementationRunId])
    expect(implementationRunId).not.toBe(plan.runId)
    running.resolve({ model: undefined, stopReason: 'stop' })
    await plan.settled
    expect(registry.isPromptActive(session.id)).toBe(true)

    host.emit({ type: 'agent_settled' })
    await vi.waitFor(() => expect(registry.isPromptActive(session.id)).toBe(false))
    await registry.close()
  })

  it('keeps a pending dialog available when Pi stdin rejects its response', async () => {
    const host = hostMock()
    host.respondToExtension.mockRejectedValueOnce(new Error('stdin closed'))
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    await registry.resume(session)
    host.emit({ id: 'dialog-1', method: 'confirm', title: 'Continue?', type: 'extension_ui_request' })
    await vi.waitFor(() => expect(registry.respondToExtension(session.id, { confirmed: true, id: 'dialog-1', type: 'extension_ui_response' })).rejects.toThrow('stdin closed'))

    await expect(registry.respondToExtension(session.id, { confirmed: true, id: 'dialog-1', type: 'extension_ui_response' })).resolves.toBe(true)
    await registry.close()
  })

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

    await expect(registry.watch('one', 'socket-a', 1, () => undefined, () => undefined)).resolves.toBeTypeOf('function')
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

  it('replays the entire active Turn to a refreshed watcher', async () => {
    const host = hostMock()
    const running = deferred<{ model: undefined; stopReason: string }>()
    host.prompt.mockReturnValueOnce(running.promise)
    const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
    const firstEvents: number[] = []
    await registry.watch(session.id, 'tab-a', 0, (event) => firstEvents.push(event.sequence), () => undefined)
    const prompt = registry.startPrompt(session, 'resume this prompt')
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledWith('resume this prompt'))
    host.emit({ type: 'turn_start' })
    host.emit({ type: 'message_update' })
    await vi.waitFor(() => expect(firstEvents).toEqual([1, 2]))

    const replayed: number[] = []
    const snapshots: any[] = []
    await registry.watch(session.id, 'tab-b', 0, (event) => replayed.push(event.sequence), () => undefined, (snapshot) => snapshots.push(snapshot))

    expect(snapshots).toMatchObject([{ activeTurn: { prompt: 'resume this prompt' }, replayAfter: 0, runtime: { lifecycle: 'active' } }])
    expect(replayed).toEqual([1, 2])
    running.resolve({ model: undefined, stopReason: 'stop' })
    await expect(prompt).resolves.toMatchObject({ stopReason: 'stop' })
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
    await expect(registry.watch(session.id, 'tab-b', 1, () => undefined, () => undefined)).resolves.toBeTypeOf('function')

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

it('keeps warm resume and control reads silent while preserving admission locks', async () => {
  const read = deferred<Record<string, unknown>>()
  const host = { ...hostMock(), command: vi.fn().mockResolvedValue({ data: {} }) }
  const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
  const statuses: any[] = []
  try {
    await registry.watch(session.id, 'quiet-reader', 0, () => undefined, () => undefined, () => undefined, (status) => statuses.push(status))
    await registry.resume(session)
    expect(statuses.map((status) => status.lifecycle)).toEqual(['loading', 'idle'])
    const count = statuses.length
    await registry.resume(session)
    host.command.mockReturnValueOnce(read.promise)
    const state = registry.commandWhenIdle(session, { type: 'get_state' })!
    expect(() => registry.commandWhenIdle(session, { type: 'get_available_models' })).toThrow(PiRuntimeBusyError)
    expect(statuses).toHaveLength(count)
    read.resolve({ data: {} })
    await state
    await registry.commandWhenIdle(session, { type: 'get_available_models' })
    await registry.commandWhenIdle(session, { type: 'get_available_thinking_levels' })
    await registry.commandWhenIdle(session, { type: 'get_commands' })
    host.command.mockRejectedValueOnce(new PiRpcCommandError('read denied'))
    await expect(registry.commandWhenIdle(session, { type: 'get_state' })).rejects.toThrow('read denied')
    expect(statuses).toHaveLength(count)
    expect(host.close).not.toHaveBeenCalled()
  } finally { read.resolve({ data: {} }); await registry.close() }
})

it('still publishes model and thinking changes observed during an idle state read', async () => {
  const host = { ...hostMock(), currentModel: { provider: 'test', id: 'old' }, currentThinkingLevel: 'low', command: vi.fn() }
  const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
  const statuses: any[] = []
  try {
    await registry.watch(session.id, 'metadata-reader', 0, () => undefined, () => undefined, () => undefined, (status) => statuses.push(status))
    await registry.resume(session)
    const revision = statuses.at(-1).revision
    host.command.mockImplementationOnce(async () => { host.currentModel = { provider: 'test', id: 'new' }; host.currentThinkingLevel = 'high'; return { data: {} } })
    await registry.commandWhenIdle(session, { type: 'get_state' })
    expect(statuses.at(-1)).toMatchObject({ lifecycle: 'idle', model: { id: 'new' }, thinkingLevel: 'high', revision: revision + 1 })
    expect(statuses.filter((status) => status.lifecycle === 'loading')).toHaveLength(1)
  } finally { await registry.close() }
})

it('keeps same-text attachments distinct through queue promotion and persists a recoverable queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-attachment-queue-'))
  const host = { ...hostMock(), command: vi.fn().mockResolvedValue({ success: true }) }
  host.prompt.mockImplementation(() => new Promise(() => {}))
  const registry = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: () => host as unknown as PiRuntimeHost })
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(text)); c.close() } })
  try {
    await registry.beginPrompt(session, 'first')!.accepted
    const a = await registry.attachments.upload(stream('one'), session.id, 'one.txt', 'text/plain')
    const b = await registry.attachments.upload(stream('two'), session.id, 'two.txt', 'text/plain')
    const first = { type: 'follow_up', message: 'same', attachmentIds: [a.id], submissionId: crypto.randomUUID() }
    const second = { type: 'follow_up', message: 'same', attachmentIds: [b.id], submissionId: crypto.randomUUID() }
    await registry.commandWhileRunning(session.id, first)
    await registry.commandWhileRunning(session.id, second)
    await registry.commandWhileRunning(session.id, first)
    expect(registry.attachments.queue(session.id)).toHaveLength(2)
    host.command.mockRejectedValueOnce(new Error('steer refused'))
    await expect(registry.commandWhileRunning(session.id, { type: 'steer_queued', inputId: second.submissionId, message: 'same', index: 0 })).rejects.toThrow('refused')
    expect(registry.attachments.queue(session.id)).toHaveLength(2)
    await registry.commandWhileRunning(session.id, { type: 'steer_queued', inputId: second.submissionId, message: 'same', index: 0 })
    expect(host.command.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'steer', message: expect.stringContaining(b.id) })
    const { capturePiSessionHistory } = await import('@pi-nest/pi-adapter')
    vi.mocked(capturePiSessionHistory).mockReturnValueOnce({ bytes: 1, revision: 'a'.repeat(64), entries: [{ type: 'message', id: 'steered', parentId: null, timestamp: 'now', message: { role: 'user', timestamp: 1, content: host.command.mock.calls.at(-1)![0].message } }] })
    host.emit({ type: 'turn_end' })
    expect(registry.attachments.queue(session.id).map((input) => input.id)).toEqual([first.submissionId])
    const restarted = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: () => hostMock() as unknown as PiRuntimeHost })
    const snapshots: any[] = []
    try {
      const unwatch = await restarted.watch(session.id, 'restored', 0, () => {}, () => {}, (snapshot) => snapshots.push(snapshot))
      expect(snapshots.at(-1).inputQueue.inputs).toMatchObject([{ id: first.submissionId, recoveryRequired: true, attachments: [{ id: a.id }] }])
      unwatch()
    } finally { await restarted.close() }
  } finally { await registry.close(); const { rm } = await import('node:fs/promises'); await rm(directory, { force: true, recursive: true }) }
})

it('retires a recovered attachment queue item already recorded by Pi instead of replaying it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-attachment-recovery-'))
  const registry = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: vi.fn() })
  const id = crypto.randomUUID()
  registry.attachments.queue(session.id, [{ id, submissionId: id, message: 'already done' }])
  const { capturePiSessionHistory } = await import('@pi-nest/pi-adapter')
  vi.mocked(capturePiSessionHistory).mockReturnValueOnce({ bytes: 1, revision: 'a'.repeat(64), entries: [{ type: 'message', id: 'native', parentId: null, timestamp: 'now', message: { role: 'user', timestamp: 1, content: `already done\n\n<pi-nest-attachments id="${id}">\n[]\n</pi-nest-attachments>` } }] })
  try {
    await registry.resumeQueued(session, id)
    expect(registry.attachments.queue(session.id)).toEqual([])
  } finally { await registry.close(); const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }) }
})

it('persists accepted attachment steering until the native user message is observed and restores its full receipt after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-steering-recovery-'))
  const host = { ...hostMock(), command: vi.fn().mockResolvedValue({ success: true }) }
  host.prompt.mockImplementation(() => new Promise(() => {}))
  const registry = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: () => host as unknown as PiRuntimeHost })
  try {
    await registry.beginPrompt(session, 'first')!.accepted
    const file = await registry.attachments.upload(new ReadableStream({ start(c) { c.enqueue(Buffer.from('steering file')); c.close() } }), session.id, 'input.txt', 'text/plain')
    const input = { message: 'change direction', attachmentIds: [file.id], submissionId: crypto.randomUUID() }
    await registry.commandWhileRunning(session.id, { type: 'steer', ...input })
    const nativeMessage = host.command.mock.calls.at(-1)![0].message
    host.emit({ type: 'queue_update', steering: [nativeMessage], followUp: [] })
    const snapshots: any[] = []
    const stop = await registry.watch(session.id, 'steering', 0, () => {}, () => {}, (snapshot) => snapshots.push(snapshot))
    expect(snapshots.at(-1).inputQueue.steering).toEqual(['change direction'])
    expect(snapshots.at(-1).inputQueue.steeringInputs[0]).toMatchObject({ id: input.submissionId, attachments: [{ id: file.id }] })
    stop()
    const restarted = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: () => hostMock() as unknown as PiRuntimeHost })
    try {
      const restored: any[] = []
      const unwatch = await restarted.watch(session.id, 'restarted', 0, () => {}, () => {}, (snapshot) => restored.push(snapshot))
      expect(restored.at(-1).inputQueue.inputs).toMatchObject([{ id: input.submissionId, recoveryRequired: true, attachmentIds: [file.id] }])
      unwatch()
    } finally { await restarted.close() }
    host.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: nativeMessage }] } })
    expect(registry.attachments.steering(session.id)).toHaveLength(1)
    const { capturePiSessionHistory } = await import('@pi-nest/pi-adapter')
    vi.mocked(capturePiSessionHistory).mockReturnValueOnce({ bytes: 1, revision: 'a'.repeat(64), entries: [{ type: 'message', id: 'steered', parentId: null, timestamp: 'now', message: { role: 'user', timestamp: 1, content: nativeMessage } }] })
    host.emit({ type: 'turn_end' })
    expect(registry.attachments.steering(session.id)).toEqual([])
  } finally { await registry.close(); const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }) }
})

it('applies first-prompt settings under the prompt lock before sending any prompt', async () => {
  const host = { ...hostMock(), command: vi.fn(async (command: Record<string, unknown>) => ({ data: command.type === 'get_available_thinking_levels' ? { levels: ['off', 'high'] } : {} })) }
  const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
  try {
    const prompt = registry.beginPrompt(session, 'first', undefined, { model: { provider: 'test', id: 'reasoning' }, thinkingLevel: 'high' })!
    expect(registry.beginPrompt(session, 'duplicate')).toBeUndefined()
    await prompt.accepted
    await prompt.settled
    expect(host.command.mock.calls.map(([command]) => command)).toEqual([
      { type: 'set_model', provider: 'test', modelId: 'reasoning' },
      { type: 'get_available_thinking_levels' },
      { type: 'set_thinking_level', level: 'high' },
    ])
    expect(host.command.mock.invocationCallOrder.at(-1)).toBeLessThan(host.beginPrompt.mock.invocationCallOrder[0]!)
    expect(host.beginPrompt).toHaveBeenCalledWith('first', undefined)
  } finally { await registry.close() }
})

it.each(['unsupported-level', 'model-error'])('never sends the first prompt when initial configuration fails: %s', async (failure) => {
  const host = { ...hostMock(), command: vi.fn(async (_command: Record<string, unknown>) => {
    if (failure === 'model-error') throw new PiRpcCommandError('Model not found')
    return { data: { levels: ['off'] } }
  }) }
  const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
  try {
    const prompt = registry.beginPrompt(session, 'first', undefined, { model: { provider: 'test', id: 'reasoning' }, thinkingLevel: 'high' })!
    await expect(prompt.accepted).rejects.toThrow()
    await expect(prompt.settled).rejects.toThrow()
    expect(host.beginPrompt).not.toHaveBeenCalled()
    expect(host.command.mock.calls.some(([command]) => (command as { type: string }).type === 'set_thinking_level')).toBe(false)
  } finally { await registry.close() }
})

it('allows abort during manual compaction and cleans up after completion', async () => {
  const control = deferred<Record<string, unknown>>()
  const host = { ...hostMock(), command: vi.fn(() => control.promise) }
  const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
  try {
    await registry.resume(session)
    const compact = registry.commandWhenIdle(session, { type: 'compact' })!
    await vi.waitFor(() => expect(host.command).toHaveBeenCalledWith({ type: 'compact' }))
    expect(await registry.abort(session.id)).toBe(true)
    expect(host.abort).toHaveBeenCalledOnce()
    control.resolve({ success: true })
    await compact
    expect(await registry.abort(session.id)).toBe(false)
  } finally { await registry.close() }
})


it('validates mutations under the lock before unloading and releases the lock on validation failure', async () => {
  const host = hostMock()
  const registry = new PiRuntimeRegistry({ createHost: () => host as unknown as PiRuntimeHost })
  try {
    await registry.resume(session)
    const invalid = registry.beginMutation(session.id, () => {
      expect(host.close).not.toHaveBeenCalled()
      expect(registry.beginMutation(session.id)).toBeUndefined()
      throw new Error('stale revision')
    })
    await expect(invalid).rejects.toThrow('stale revision')
    expect(host.close).not.toHaveBeenCalled()
    const validate = vi.fn(() => { expect(host.close).not.toHaveBeenCalled() })
    const finish = await registry.beginMutation(session.id, validate)
    expect(validate).toHaveBeenCalledOnce()
    expect(host.close).toHaveBeenCalledOnce()
    expect(registry.beginMutation(session.id)).toBeUndefined()
    finish?.()
    const next = await registry.beginMutation(session.id)
    expect(next).toBeTypeOf('function')
    next?.()
  } finally { await registry.close() }
})
