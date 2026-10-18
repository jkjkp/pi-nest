import { describe, expect, it, vi } from 'vitest'

import { PiRuntimeHost } from './pi-runtime-host.js'

class FakeProcess {
  readonly commands: Record<string, unknown>[] = []
  closed = false
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>()
  private readonly failures = new Set<(error: Error) => void>()
  private stateReads = 0

  async start() {
    return { sessionId: 'session-1', state: { sessionId: 'session-1' } }
  }

  onEvent(listener: (event: Record<string, unknown>) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onFailure(listener: (error: Error) => void) {
    this.failures.add(listener)
    return () => this.failures.delete(listener)
  }

  async send(command: Record<string, unknown>) {
    this.commands.push(command)
    if (command.type === 'get_state') {
      this.stateReads += 1
      return { data: { isStreaming: this.stateReads === 1, model: { provider: 'test', id: 'model' } } }
    }
    return { success: true }
  }

  async close() { this.closed = true }

  emit(event: Record<string, unknown>) {
    for (const listener of this.listeners) listener(event)
  }
}

function hostFor(process: FakeProcess) {
  return new PiRuntimeHost(
    { cwd: '/fixture', id: 'session-1', sessionFile: '/fixture/session.jsonl' },
    () => process as never,
  )
}

describe('PiRuntimeHost', () => {
  it('caches the Pi-selected startup model and refreshes it after a state read', async () => {
    const process = new FakeProcess()
    process.start = async () => ({ sessionId: 'session-1', state: { sessionId: 'session-1', model: { provider: 'test', id: 'default' }, thinkingLevel: 'medium' } })
    const host = hostFor(process)
    await host.start()
    expect(host.currentThinkingLevel).toBe('medium')
    process.emit({ type: 'thinking_level_changed', level: 'high' })
    expect(host.currentThinkingLevel).toBe('high')
    expect(host.currentModel).toEqual({ provider: 'test', id: 'default' })
    host.currentModel!.id = 'mutated'
    expect(host.currentModel?.id).toBe('default')
    await host.command({ type: 'get_state' })
    expect(host.currentModel?.id).toBe('model')
    await host.close()
  })

  it('separates prompt admission from agent settlement for first-session creation', async () => {
    const process = new FakeProcess()
    const host = hostFor(process)
    const prompt = host.beginPrompt('hello')

    await expect(prompt.accepted).resolves.toBeUndefined()
    expect(process.commands).toContainEqual({ type: 'prompt', message: 'hello' })
    process.emit({ type: 'agent_settled' })
    await expect(prompt.settled).resolves.toMatchObject({ stopReason: 'stop' })
  })

  it('preserves every raw Pi event, including unknown types, for the registry event stream', async () => {
    const process = new FakeProcess()
    const host = hostFor(process)
    const events: unknown[] = []
    host.onEvent((event) => events.push(event))

    const prompt = host.prompt('hello')
    await vi.waitFor(() => expect(process.commands).toContainEqual({ type: 'prompt', message: 'hello' }))
    const unknown = { type: 'future_pi_event', payload: { value: 1 } }
    process.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } })
    process.emit(unknown)
    process.emit({ type: 'agent_settled' })

    await expect(prompt).resolves.toEqual({ model: { provider: 'test', id: 'model' }, stopReason: 'stop' })
    expect(events).toMatchObject([
      { sessionId: 'session-1', event: { type: 'message_update' } },
      { sessionId: 'session-1', event: unknown },
      { sessionId: 'session-1', event: { type: 'agent_settled' } },
    ])
    expect((events[1] as { event: unknown }).event).toBe(unknown)
  })

  it('does not wait for settlement of an input handled by an extension', async () => {
    const process = new FakeProcess()
    const send = process.send.bind(process)
    vi.spyOn(process, 'send').mockImplementation(async (command) => command.type === 'prompt'
      ? { success: true, data: { disposition: 'handled' } } as never
      : command.type === 'get_state' ? { data: { isStreaming: false } } as never : send(command))
    const host = hostFor(process)
    await expect(host.prompt('/extension-command')).resolves.toMatchObject({ stopReason: 'stop' })
    expect(host.isRunning).toBe(false)
    await host.close()
  })

  it.each(['started', 'queued', 'handled'])('waits for settlement of a %s input', async (disposition) => {
    const process = new FakeProcess()
    const send = process.send.bind(process)
    vi.spyOn(process, 'send').mockImplementation(async (command) => command.type === 'prompt'
      ? { success: true, data: { disposition } } as never
      : send(command))
    const host = hostFor(process)
    const prompt = host.beginPrompt('hello')
    await prompt.accepted
    await vi.waitFor(() => expect(process.commands).toContainEqual({ type: 'get_state' }))
    expect(host.isRunning).toBe(true)
    process.emit({ type: 'agent_settled', aborted: false })
    await expect(prompt.settled).resolves.toMatchObject({ stopReason: 'stop' })
    await host.close()
  })

  it('uses the settled abort flag without an assistant message or a local abort request', async () => {
    const process = new FakeProcess()
    const host = hostFor(process)
    const prompt = host.beginPrompt('hello')
    await prompt.accepted
    process.emit({ type: 'agent_settled', aborted: true })
    await expect(prompt.settled).resolves.toMatchObject({ stopReason: 'aborted' })
    await host.close()
  })

  it('returns the final assistant stop reason instead of a streaming placeholder or an earlier tool turn', async () => {
    const process = new FakeProcess()
    const host = hostFor(process)
    const prompt = host.beginPrompt('hello')
    await prompt.accepted
    process.emit({ type: 'message_start', message: { role: 'assistant', stopReason: 'pending' } })
    process.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } })
    process.emit({ type: 'message_start', message: { role: 'assistant', stopReason: 'pending' } })
    process.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
    process.emit({ type: 'agent_settled', aborted: false })
    await expect(prompt.settled).resolves.toMatchObject({ stopReason: 'stop' })
    await host.close()
  })

  it('uses Pi abort and retains the aborted terminal state', async () => {
    const process = new FakeProcess()
    const host = hostFor(process)
    const prompt = host.prompt('hello')
    await vi.waitFor(() => expect(process.commands).toContainEqual({ type: 'prompt', message: 'hello' }))

    await expect(host.abort()).resolves.toBe(true)
    expect(process.commands).toContainEqual({ type: 'abort' })
    process.emit({ type: 'agent_settled' })
    await expect(prompt).resolves.toMatchObject({ stopReason: 'aborted' })
  })

  it('cleans up the native process when an RPC command fails', async () => {
    const process = new FakeProcess()
    process.send = vi.fn().mockRejectedValue(new Error('rpc failed'))
    const host = hostFor(process)

    await expect(host.prompt('hello')).rejects.toThrow('rpc failed')
    expect(process.closed).toBe(true)
    expect(host.isRunning).toBe(false)
  })

  it('times out a stalled Pi startup and closes its process', async () => {
    vi.useFakeTimers()
    const process = new FakeProcess()
    process.start = vi.fn(() => new Promise<{ sessionId: string; state: { sessionId: string } }>(() => undefined))
    const host = new PiRuntimeHost(
      { cwd: '/fixture', id: 'session-1', sessionFile: '/fixture/session.jsonl' },
      () => process as never,
      10,
    )

    const started = expect(host.start()).rejects.toMatchObject({ failure: { kind: 'startup_timeout' } })
    await vi.advanceTimersByTimeAsync(10)
    await started
    expect(process.closed).toBe(true)
    vi.useRealTimers()
  })
})

it('reads native session totals and adds the actual auto-compaction setting', async () => {
  const process = new FakeProcess()
  const send = process.send.bind(process)
  vi.spyOn(process, 'send').mockImplementation(async (command) => {
    if (command.type === 'get_session_stats') return { data: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 }, cost: 0.01, contextUsage: { tokens: null, percent: null, contextWindow: 1000000 } } } as never
    const response = await send(command)
    if (command.type === 'get_state') return { ...response, data: { ...response.data, autoCompactionEnabled: true } } as never
    return response
  })
  const host = hostFor(process)
  const response = await host.command({ type: 'get_session_stats' })
  expect(response.data).toMatchObject({ cost: 0.01, autoCompactionEnabled: true, contextUsage: { percent: null } })
  await host.close()
})

it('passes image input to the real RPC shape and refuses a known text-only model before prompt admission', async () => {
  const image = { type: 'image' as const, data: 'base64', mimeType: 'image/png' }
  const process = new FakeProcess()
  process.send = vi.fn(async (command) => command.type === 'get_state' ? { data: { isStreaming: false, model: { input: ['text', 'image'] } } } : { success: true }) as typeof process.send
  const host = hostFor(process)
  const prompt = host.beginPrompt('look', [image])
  await prompt.accepted
  await prompt.settled
  expect(process.send).toHaveBeenCalledWith({ type: 'prompt', message: 'look', images: [image] })
  await host.close()
  const unsupported = new FakeProcess()
  unsupported.send = vi.fn(async () => ({ data: { model: { input: ['text'] } } })) as unknown as typeof unsupported.send
  const next = hostFor(unsupported).beginPrompt('look', [image])
  void next.settled.catch(() => {})
  await expect(next.accepted).rejects.toThrow('不支持图片')
  expect(unsupported.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' }))
})
