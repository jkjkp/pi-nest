import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SessionEventStream } from './session-event-stream.js'

const raw = (event: Record<string, unknown>) => ({ event, observedAt: 'now', sessionId: 'session-1' })

describe('SessionEventStream', () => {
  it('writes 0600 JSONL before replaying unknown events in sequence order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-nest-stream-test-'))
    const stream = new SessionEventStream('session-1', Promise.resolve(directory))
    const unknown = { payload: { retained: true }, type: 'future_pi_event' }
    await stream.publish(raw({ type: 'message_start' }))
    await stream.publish(raw(unknown))

    const replayed: unknown[] = []
    await stream.subscribe(1, (event) => replayed.push(event), () => undefined)
    expect(replayed).toEqual([{ event: unknown, observedAt: 'now', sequence: 2, sessionId: 'session-1' }])

    const files = await (await import('node:fs/promises')).readdir(directory)
    expect(files).toHaveLength(1)
    expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600)
    await stream.close()
    await (await import('node:fs/promises')).rm(directory, { force: true, recursive: true })
  })

  it('serializes replay registration with a following live event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-nest-stream-test-'))
    const stream = new SessionEventStream('session-1', Promise.resolve(directory))
    await stream.publish(raw({ type: 'first' }))
    const received: number[] = []
    const subscribed = stream.subscribe(0, (event) => received.push(event.sequence), () => undefined)
    const published = stream.publish(raw({ type: 'second' }))
    await Promise.all([subscribed, published])
    expect(received).toEqual([1, 2])
    await stream.close()
    await (await import('node:fs/promises')).rm(directory, { force: true, recursive: true })
  })

  it('captures a snapshot before replay at the identical event sequence boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-nest-stream-test-'))
    const stream = new SessionEventStream('session-1', Promise.resolve(directory))
    await stream.publish(raw({ type: 'first' }))
    const order: string[] = []
    await stream.subscribeWithSnapshot(
      0,
      (atSequence) => ({ atSequence }),
      (snapshot) => order.push(`snapshot:${snapshot.atSequence}`),
      (event) => order.push(`event:${event.sequence}`),
      () => undefined,
    )
    expect(order).toEqual(['snapshot:1', 'event:1'])
    await stream.close()
    await (await import('node:fs/promises')).rm(directory, { force: true, recursive: true })
  })

  it('assigns a stable turn ID only between native turn boundaries and replays it unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-nest-stream-test-'))
    const stream = new SessionEventStream('session-1', Promise.resolve(directory))
    await stream.publish(raw({ type: 'model_change' }))
    await stream.publish(raw({ type: 'turn_start' }))
    await stream.publish(raw({ type: 'future_pi_event', nested: { retained: true } }))
    await stream.publish(raw({ type: 'turn_end' }))
    await stream.publish(raw({ type: 'thinking_level_changed' }))

    const replayed: Array<{ event: Record<string, unknown>; turnId?: string }> = []
    await stream.subscribe(0, (event) => replayed.push(event), () => undefined)
    expect(replayed.map((event) => event.turnId)).toEqual([
      undefined,
      'session-1:turn:2',
      'session-1:turn:2',
      'session-1:turn:2',
      undefined,
    ])
    expect(replayed[2]?.event).toEqual({ type: 'future_pi_event', nested: { retained: true } })
    await stream.close()
    await (await import('node:fs/promises')).rm(directory, { force: true, recursive: true })
  })

  it('reports a buffer failure instead of broadcasting an event that cannot be replayed', async () => {
    const stream = new SessionEventStream('session-1', Promise.resolve('/dev/null'))
    const errors: string[] = []
    await stream.subscribe(0, () => undefined, (error) => errors.push(error.code))
    await stream.publish(raw({ type: 'must_not_publish' }))
    expect(errors).toEqual(['EVENT_BUFFER_FAILED'])
  })
})
