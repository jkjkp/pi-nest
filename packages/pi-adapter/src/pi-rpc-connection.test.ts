import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { PiRpcConnection } from './pi-rpc-connection.js'

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

  constructor(exitOnStdinEnd = true) {
    super()
    if (exitOnStdinEnd) {
      this.stdin.once('finish', () => {
        this.exitCode = 0
        this.emit('exit', 0, null)
      })
    }
  }
}

function createConnection(child: FakeChild) {
  const spawnProcess = vi.fn(() => child)
  const connection = new PiRpcConnection({
    commandTimeoutMs: 100,
    cwd: '/fixture',
    executable: '/fixture/pi',
    sessionFile: '/fixture/session.jsonl',
    spawnProcess: spawnProcess as any,
  })
  return { connection, spawnProcess }
}

describe('PiRpcConnection', () => {
  it('uses LF-only framing and preserves unknown stdout objects unchanged', async () => {
    const child = new FakeChild()
    const { connection } = createConnection(child)
    const records: unknown[] = []
    connection.onRecord((record) => records.push(record))
    await connection.start()

    const record = { type: 'future_pi_event', value: 'one\u2028two', nested: { keep: true } }
    child.stdout.write(`${JSON.stringify(record).slice(0, 20)}`)
    child.stdout.write(`${JSON.stringify(record).slice(20)}\n`)

    await new Promise((resolve) => setImmediate(resolve))
    expect(records).toEqual([record])
    expect((child.stdin as any).readable).toBe(true)
    await connection.close()
  })

  it('correlates a response only with its command id', async () => {
    const child = new FakeChild()
    const { connection } = createConnection(child)
    await connection.start()
    const request = connection.send({ type: 'get_state' })
    child.stdout.write('{"id":"other","type":"response","command":"get_state","success":true}\n')
    child.stdout.write('{"id":"pi-nest-rpc-1","type":"response","command":"get_state","success":true,"data":{}}\n')

    await expect(request).resolves.toMatchObject({ id: 'pi-nest-rpc-1', command: 'get_state' })
    await connection.close()
  })

  it('writes extension UI responses as normal JSONL without creating a pending command', async () => {
    const child = new FakeChild()
    const { connection } = createConnection(child)
    const writes: string[] = []
    child.stdin.on('data', (chunk) => writes.push(chunk.toString('utf8')))
    await connection.start()

    connection.write({ type: 'extension_ui_response', id: 'ui-1', value: 'fixture-input' })

    expect(writes).toEqual(['{"type":"extension_ui_response","id":"ui-1","value":"fixture-input"}\n'])
    await connection.close()
  })

  it('keeps stdin open until cleanup, then terminates the child process', async () => {
    const child = new FakeChild()
    const { connection, spawnProcess } = createConnection(child)
    await connection.start()

    expect(spawnProcess).toHaveBeenCalledWith(
      '/fixture/pi',
      ['--mode', 'rpc', '--session', '/fixture/session.jsonl'],
      { cwd: '/fixture', stdio: 'pipe' },
    )
    expect(child.stdin.writableEnded).toBe(false)
    await connection.close()
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('terminates a child that ignores stdin cleanup', async () => {
    const child = new FakeChild(false)
    const spawnProcess = vi.fn(() => child)
    const connection = new PiRpcConnection({
      commandTimeoutMs: 100,
      cwd: '/fixture',
      executable: '/fixture/pi',
      sessionFile: '/fixture/session.jsonl',
      spawnProcess: spawnProcess as any,
      stopTimeoutMs: 1,
    })
    await connection.start()
    await connection.close()

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('fails later commands with the original child-process error', async () => {
    const child = new FakeChild()
    const { connection } = createConnection(child)
    await connection.start()
    child.emit('error', new Error('spawn failed'))

    await expect(connection.send({ type: 'get_state' })).rejects.toMatchObject({
      message: 'Pi RPC process error: spawn failed',
    })
    await connection.close()
  })

  it('reports an unexpected child exit to failure observers', async () => {
    const child = new FakeChild()
    const { connection } = createConnection(child)
    const failures: string[] = []
    connection.onFailure((error) => failures.push(error.failureKind))
    await connection.start()

    child.emit('exit', 1, null)

    expect(failures).toEqual(['process_exit'])
    await connection.close()
  })
})
