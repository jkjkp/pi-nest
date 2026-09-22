import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { PiRpcProcess } from './pi-rpc-process.js'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn(() => {
    this.exitCode = 0
    this.emit('exit', 0, null)
    return true
  })

  constructor() {
    super()
    this.stdin.once('finish', () => this.emit('exit', 0, null))
  }
}

function createProcess(child: FakeChild, expectedSessionId = 'session-1') {
  const spawnProcess = vi.fn(() => child)
  const process = new PiRpcProcess({
    cwd: '/fixture',
    expectedSessionId,
    piExecutable: '/fixture/pi',
    sessionFile: '/fixture/session.jsonl',
    spawnProcess: spawnProcess as any,
  })
  return { process, spawnProcess }
}

function respondToState(child: FakeChild, sessionId = 'session-1') {
  child.stdin.once('data', (chunk) => {
    const command = JSON.parse(chunk.toString('utf8'))
    child.stdout.write(`${JSON.stringify({
      id: command.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId, sessionFile: '/fixture/session.jsonl' },
    })}\n`)
  })
}

describe('PiRpcProcess', () => {
  it('starts the locked CLI RPC command without fixture approval and resolves the native session ID', async () => {
    const child = new FakeChild()
    const { process, spawnProcess } = createProcess(child)
    respondToState(child)

    await expect(process.start()).resolves.toEqual({
      sessionId: 'session-1',
      state: { sessionId: 'session-1', sessionFile: '/fixture/session.jsonl' },
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      '/fixture/pi',
      ['--mode', 'rpc', '--session', '/fixture/session.jsonl'],
      { cwd: '/fixture', stdio: 'pipe' },
    )
    await process.close()
  })

  it('rejects a session that does not match the server-resolved ID and cleans up the child', async () => {
    const child = new FakeChild()
    const { process } = createProcess(child, 'expected-session')
    respondToState(child, 'other-session')

    await expect(process.start()).rejects.toMatchObject({
      message: 'Failed to start Pi RPC process',
    })
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('forwards unknown Pi events without changing them', async () => {
    const child = new FakeChild()
    const { process } = createProcess(child)
    const events: unknown[] = []
    process.onEvent((event) => events.push(event))
    respondToState(child)
    await process.start()

    const unknown = { type: 'future_pi_event', payload: { stable: false } }
    child.stdout.write(`${JSON.stringify(unknown)}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toContainEqual(unknown)
    await process.close()
  })
})
