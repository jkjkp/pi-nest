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
