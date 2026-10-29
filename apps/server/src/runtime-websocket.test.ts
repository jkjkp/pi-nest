import { AttachmentStore } from './attachment-store.js'
import { describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { preparePiImage } from '@pi-nest/pi-adapter'
import { RuntimeWebSocketBroker } from './runtime-websocket.js'
import { PiRuntimeBusyError, PiRuntimeCapacityError, PiRuntimeRegistry } from './pi-runtime-registry.js'
import type { PiRuntimeHost } from './pi-runtime-host.js'
import { createSessionIndexFixture } from './test-fixtures/session-index.js'

vi.mock('@pi-nest/pi-adapter', async (original) => {
  const actual = await original<typeof import('@pi-nest/pi-adapter')>()
  return { ...actual, capturePiSessionHistory: vi.fn(() => ({ entries: [], revision: 'a'.repeat(64), bytes: 1 })), preparePiImage: vi.fn(actual.preparePiImage) }
})

const nativeBinding = { cwd: '/fixture', id: 'session-1', sessionFile: '/fixture/session.jsonl' }
const nativeSession = { ...nativeBinding, firstMessage: undefined, name: undefined, updatedAt: undefined }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const imageStream = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(png, 'base64')); c.close() } })
const textStream = (text: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(text)); c.close() } })

function nativeHost() {
  const listeners = new Set<(event: { event: Record<string, unknown>; observedAt: string; sessionId: string }) => void>()
  const failures = new Set<(failure: { kind: string; message: string }) => void>()
  return {
    abort: vi.fn().mockResolvedValue(true),
    beginPrompt: vi.fn(() => ({ accepted: Promise.resolve(), settled: Promise.resolve({ model: undefined, stopReason: 'stop' }) })),
    close: vi.fn().mockResolvedValue(undefined),
    command: vi.fn().mockResolvedValue({}),
    currentModel: undefined,
    currentThinkingLevel: undefined,
    onEvent: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener) }),
    onFailure: vi.fn((listener) => { failures.add(listener); return () => failures.delete(listener) }),
    start: vi.fn().mockResolvedValue({}),
  }
}

function createBroker(registry: unknown, sessions = [nativeSession]) {
  return new RuntimeWebSocketBroker(registry as never, createSessionIndexFixture(sessions).index)
}

function socket() {
  const sent: unknown[] = []
  return { send: vi.fn((value: string) => sent.push(JSON.parse(value))), sent }
}

function runtime() {
  const subscribers = new Map<string, Set<(event: any) => void>>()
  return {
    attachments: new AttachmentStore(),
    isPromptActive: vi.fn(() => false),
    executeExtensionCommand: vi.fn().mockResolvedValue({ disposition: 'handled' }),
    abort: vi.fn().mockResolvedValue(true),
    commandWhenIdle: vi.fn<(...args: any[]) => Promise<any> | undefined>().mockResolvedValue({ data: { levels: ['low', 'high'], models: [{ id: 'model-2', name: 'Model 2', provider: 'test' }] } }),
    getSessionStatistics: vi.fn().mockResolvedValue({ data: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 }, cost: 0.1, contextUsage: { tokens: null, percent: null, contextWindow: 1000000 }, sessionFile: "/private/session.jsonl" } }),
    commandWhileRunning: vi.fn().mockResolvedValue({ success: true }),
    respondToExtension: vi.fn().mockResolvedValue(true),
    beginPrompt: vi.fn().mockReturnValue({ runId: 'run-1', settled: Promise.resolve({ stopReason: 'stop' }) }),
    resume: vi.fn().mockResolvedValue(undefined),
    unwatch: vi.fn().mockReturnValue(true),
    watch: vi.fn(async (sessionId: string, _subscriberId: string, _after: number, listener: (event: any) => void, _onError?: unknown, _snapshot?: (value: unknown) => void, _status?: (value: unknown) => void) => {
      const listeners = subscribers.get(sessionId) ?? new Set()
      listeners.add(listener)
      subscribers.set(sessionId, listeners)
      return () => { listeners.delete(listener) }
    }),
    emit: (event: any) => { for (const listener of subscribers.get(event.sessionId) ?? []) listener(event) },
  }
}

describe('RuntimeWebSocketBroker', () => {
  it('requires watch, acknowledges commands, and sends complete unknown Pi events unchanged', async () => {
    const registry = runtime()
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'p1', message: 'hello', sessionId: 'session-1', type: 'prompt' }))
    expect(client.sent).toContainEqual({ code: 'SESSION_NOT_WATCHED', id: 'p1', message: 'Pi session is not watched', sessionId: 'session-1', type: 'error' })

    await broker.message(client, JSON.stringify({ id: 'a1', resume: { after: 0 }, sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'p2', message: 'hello', sessionId: 'session-1', type: 'prompt' }))
    expect(client.sent).toContainEqual({ command: 'watch', id: 'a1', sessionId: 'session-1', type: 'ack' })
    expect(client.sent).toContainEqual({ command: 'prompt', data: { runId: 'run-1' }, id: 'p2', sessionId: 'session-1', type: 'ack' })
    expect(registry.beginPrompt).toHaveBeenCalledWith(nativeBinding, 'hello', undefined)

    const unknown = { type: 'future_pi_event', value: { retained: true } }
    registry.emit({ event: unknown, observedAt: 'now', sequence: 7, sessionId: 'session-1' })
    expect(client.sent).toContainEqual({ event: unknown, observedAt: 'now', sequence: 7, sessionId: 'session-1', type: 'pi_event' })
  })

  it('allows a connection to watch multiple sessions and disconnects without aborting Pi', async () => {
    const registry = runtime()
    const broker = createBroker(registry, [nativeSession, { ...nativeSession, id: 'session-2', sessionFile: '/fixture/session-2.jsonl' }])
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'a1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'a2', sessionId: 'session-2', type: 'watch' }))
    expect(registry.watch).toHaveBeenCalledTimes(2)
    broker.close(client)
    expect(registry.unwatch).toHaveBeenCalledTimes(2)
    expect(registry.abort).not.toHaveBeenCalled()
  })

  it('makes unwatch idempotent for one socket', async () => {
    const registry = runtime()
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'w1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'u1', sessionId: 'session-1', type: 'unwatch' }))
    await broker.message(client, JSON.stringify({ id: 'u2', sessionId: 'session-1', type: 'unwatch' }))

    expect(registry.unwatch).toHaveBeenCalledOnce()
    expect(client.sent).toContainEqual({ command: 'unwatch', data: { status: 'unwatched' }, id: 'u1', sessionId: 'session-1', type: 'ack' })
    expect(client.sent).toContainEqual({ command: 'unwatch', data: { status: 'notWatching' }, id: 'u2', sessionId: 'session-1', type: 'ack' })
  })

  it('returns capacity exhaustion before accepting a direct prompt', async () => {
    const registry = runtime()
    registry.resume.mockRejectedValueOnce(new PiRuntimeCapacityError())
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'w1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'p1', message: 'hello', sessionId: 'session-1', type: 'prompt' }))

    expect(client.sent).toContainEqual({ code: 'RUNTIME_CAPACITY_EXCEEDED', id: 'p1', message: 'Pi runtime capacity is exhausted', sessionId: 'session-1', type: 'error' })
    expect(registry.beginPrompt).not.toHaveBeenCalled()
  })

  it('replaces a subscription when watch resumes after a newer sequence', async () => {
    const registry = runtime()
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'a1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'a2', resume: { after: 7 }, sessionId: 'session-1', type: 'watch' }))

    expect(registry.watch).toHaveBeenNthCalledWith(1, 'session-1', expect.any(String), 0, expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function))
    expect(registry.watch).toHaveBeenNthCalledWith(2, 'session-1', expect.any(String), 7, expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function))
    expect(client.sent).toContainEqual({ command: 'watch', id: 'a2', sessionId: 'session-1', type: 'ack' })
  })

  it('resubscribes when watch repeats with the same cursor so replays stay possible', async () => {
    const registry = runtime()
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'a1', resume: { after: 0 }, sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'a2', resume: { after: 0 }, sessionId: 'session-1', type: 'watch' }))

    expect(registry.watch).toHaveBeenCalledTimes(2)
    expect(client.sent).toContainEqual({ command: 'watch', id: 'a2', sessionId: 'session-1', type: 'ack' })
  })

  it('sends a coherent snapshot before raw replay and the watch acknowledgement', async () => {
    const registry = runtime()
    registry.watch.mockImplementationOnce(async (_sessionId: string, _subscriberId: string, _after: number, listener: (event: any) => void, _onError: unknown, snapshot?: (value: unknown) => void) => {
      snapshot?.({
        atSequence: 7,
        extensionUi: { freshness: 'known', statuses: { agent: 'thinking' }, widgets: { todo: ['one'] } },
        runtime: { lifecycle: 'active', revision: 3 },
        sessionId: 'session-1',
      })
      listener({ event: { method: 'setStatus', type: 'extension_ui_request' }, observedAt: 'before', sequence: 7, sessionId: 'session-1' })
      listener({ event: { type: 'turn_start' }, observedAt: 'after', sequence: 8, sessionId: 'session-1' })
      return () => undefined
    })
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)

    await broker.message(client, JSON.stringify({ id: 'a1', resume: { after: 0 }, sessionId: 'session-1', type: 'watch' }))
    expect(client.sent.map((message) => (message as { type: string }).type)).toEqual(['session_snapshot', 'pi_event', 'pi_event', 'ack'])
    expect(client.sent[0]).toMatchObject({ atSequence: 7, sessionId: 'session-1', type: 'session_snapshot' })
  })

  it('uses a fresh snapshot instead of replaying an expired idle cursor', async () => {
    const registry = new PiRuntimeRegistry()
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)
    await broker.message(client, JSON.stringify({ id: 'a1', resume: { after: 1 }, sessionId: 'session-1', type: 'watch' }))
    expect(client.sent.map((message) => (message as { type: string }).type)).toEqual(['session_snapshot', 'ack'])
    await registry.close()
  })

  it('rejects malformed commands without exposing native state', async () => {
    const broker = createBroker(runtime())
    const client = socket()
    broker.open(client)
    await broker.message(client, '{bad json')
    expect(client.sent).toEqual([{ code: 'INVALID_COMMAND', message: 'WebSocket command must be valid JSON', type: 'error' }])
  })

  it('distinguishes a busy session from an unloaded runtime', async () => {
    const registry = runtime()
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)
    await broker.message(client, JSON.stringify({ id: 'w1', sessionId: 'session-1', type: 'watch' }))
    registry.commandWhenIdle.mockImplementationOnce(() => { throw new PiRuntimeBusyError() })
    await broker.message(client, JSON.stringify({ id: 'busy', sessionId: 'session-1', type: 'get_runtime_state' }))
    registry.commandWhenIdle.mockReturnValueOnce(undefined as never)
    await broker.message(client, JSON.stringify({ id: 'missing', sessionId: 'session-1', type: 'get_runtime_state' }))
    expect(client.sent).toContainEqual({ code: 'SESSION_BUSY', id: 'busy', message: 'Pi 会话正在处理其他操作，请稍后重试。', sessionId: 'session-1', type: 'error' })
    expect(client.sent).toContainEqual({ code: 'RUNTIME_NOT_LOADED', id: 'missing', message: 'Pi runtime is not loaded', sessionId: 'session-1', type: 'error' })
  })

  it('translates the web state command to native Pi get_state and preserves the web acknowledgement', async () => {
    const registry = runtime()
    registry.commandWhenIdle.mockImplementation(async (_session, command) => {
      if (command.type !== 'get_state') throw new Error(`Unknown command: ${command.type}`)
      return { data: { isStreaming: false, isCompacting: false, model: { provider: 'test', id: 'native-model' }, thinkingLevel: 'high', sessionFile: '/private/native-session.jsonl' } } as never
    })
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)
    await broker.message(client, JSON.stringify({ id: 'watch', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'state', sessionId: 'session-1', type: 'get_runtime_state' }))
    expect(registry.commandWhenIdle).toHaveBeenCalledWith(nativeBinding, { type: 'get_state' })
    const ack = client.sent.find((message: any) => message.id === 'state') as any
    expect(ack).toMatchObject({ type: 'ack', command: 'get_runtime_state', data: { model: { provider: 'test', id: 'native-model' }, thinkingLevel: 'high' } })
    expect(ack.data).not.toHaveProperty('sessionFile')
  })

  it('forwards advanced controls only after explicit resume and keeps returned data safe', async () => {
    const registry = runtime()
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)
    await broker.message(client, JSON.stringify({ id: 's1', message: 'focus on tests', sessionId: 'session-1', type: 'steer' }))
    expect(client.sent).toContainEqual({ code: 'SESSION_NOT_WATCHED', id: 's1', message: 'Pi session is not watched', sessionId: 'session-1', type: 'error' })
    await broker.message(client, JSON.stringify({ id: 'a1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'r1', sessionId: 'session-1', type: 'resume' }))
    await broker.message(client, JSON.stringify({ id: 'm1', sessionId: 'session-1', type: 'get_available_models' }))
    await broker.message(client, JSON.stringify({ id: 'u1', dialogId: 'dialog-1', sessionId: 'session-1', type: 'extension_ui_response', value: 'yes' }))
    expect(registry.commandWhenIdle).toHaveBeenCalledWith(nativeBinding, { type: 'get_available_models' })
    expect(registry.respondToExtension).toHaveBeenCalledWith('session-1', { id: 'dialog-1', type: 'extension_ui_response', value: 'yes' })
    expect(client.sent).toContainEqual({ command: 'get_available_models', data: { models: [{ id: 'model-2', name: 'Model 2', provider: 'test' }] }, id: 'm1', sessionId: 'session-1', type: 'ack' })
  })

  it('forwards cancellation unchanged for a pending extension dialog', async () => {
    const registry = runtime()
    const broker = createBroker(registry)
    const client = socket()
    broker.open(client)
    await broker.message(client, JSON.stringify({ id: 'w1', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ cancelled: true, dialogId: 'dialog-1', id: 'c1', sessionId: 'session-1', type: 'extension_ui_response' }))

    expect(registry.respondToExtension).toHaveBeenCalledWith('session-1', { cancelled: true, id: 'dialog-1', type: 'extension_ui_response' })
    expect(client.sent).toContainEqual({ command: 'extension_ui_response', id: 'c1', sessionId: 'session-1', type: 'ack' })
  })
})


it('reads safe statistics without an idle mutation and reports invalid data', async () => {
  const registry = runtime()
  const broker = createBroker(registry)
  const client = socket()
  broker.open(client)
  await broker.message(client, JSON.stringify({ id: 'watch-stats', sessionId: 'session-1', type: 'watch' }))
  await broker.message(client, JSON.stringify({ id: 'stats', sessionId: 'session-1', type: 'get_session_stats' }))
  const ack = client.sent.find((message: any) => message.id === 'stats') as any
  expect(ack).toMatchObject({ type: 'ack', command: 'get_session_stats', data: { cost: 0.1, contextUsage: { percent: null } } })
  expect(ack.data).not.toHaveProperty('sessionFile')
  expect(registry.commandWhenIdle).not.toHaveBeenCalled()
  registry.getSessionStatistics.mockResolvedValueOnce({ data: { cost: -1 } } as never)
  await broker.message(client, JSON.stringify({ id: 'invalid-stats', sessionId: 'session-1', type: 'get_session_stats' }))
  expect(client.sent).toContainEqual(expect.objectContaining({ id: 'invalid-stats', type: 'error', code: 'COMMAND_FAILED' }))
})

it('reads native commands only after watch and strips paths and extra metadata', async () => {
  const registry = runtime()
  registry.commandWhenIdle.mockResolvedValue({ data: { commands: [
    { name: 'plan', description: 'Plan work', source: 'extension', sourceInfo: { path: '/private/extension.ts' } },
    { name: 'skill:test', source: 'skill', filePath: '/private/SKILL.md' },
  ], privateField: 'secret' } })
  const broker = createBroker(registry)
  const client = socket()
  broker.open(client)
  await broker.message(client, JSON.stringify({ id: 'c0', sessionId: 'session-1', type: 'get_commands' }))
  expect(registry.commandWhenIdle).not.toHaveBeenCalled()
  await broker.message(client, JSON.stringify({ id: 'w', sessionId: 'session-1', type: 'watch' }))
  await broker.message(client, JSON.stringify({ id: 'c1', sessionId: 'session-1', type: 'get_commands' }))
  expect(registry.commandWhenIdle).toHaveBeenCalledWith(nativeBinding, { type: 'get_commands' })
  expect(client.sent).toContainEqual({ type: 'ack', command: 'get_commands', id: 'c1', sessionId: 'session-1', data: { commands: [
    { name: 'plan', description: 'Plan work', source: 'extension' }, { name: 'skill:test', source: 'skill' },
  ] } })
  registry.commandWhenIdle.mockResolvedValue({ data: { commands: [{ name: 'bad name', source: 'unknown' }] } })
  await broker.message(client, JSON.stringify({ id: 'c2', sessionId: 'session-1', type: 'get_commands' }))
  expect(client.sent).toContainEqual(expect.objectContaining({ type: 'error', code: 'COMMAND_FAILED', id: 'c2' }))
})

it('validates and forwards optional compaction instructions without exposing native data', async () => {
  const registry = runtime()
  const broker = createBroker(registry)
  const client = socket()
  broker.open(client)
  await broker.message(client, JSON.stringify({ id: 'w', sessionId: 'session-1', type: 'watch' }))
  await broker.message(client, JSON.stringify({ id: 'c', sessionId: 'session-1', type: 'compact', customInstructions: ' 保留接口设计 ' }))
  expect(registry.commandWhenIdle).toHaveBeenCalledWith(nativeBinding, { type: 'compact', customInstructions: '保留接口设计' })
  expect(client.sent).toContainEqual({ type: 'ack', command: 'compact', id: 'c', sessionId: 'session-1' })
  registry.commandWhenIdle.mockClear()
  for (const customInstructions of ['', 'x'.repeat(20001), 42]) {
    await broker.message(client, JSON.stringify({ id: 'bad', sessionId: 'session-1', type: 'compact', customInstructions }))
    expect(client.sent.at(-1)).toMatchObject({ type: 'error', code: 'INVALID_COMMAND' })
  }
  expect(registry.commandWhenIdle).not.toHaveBeenCalled()
})

it('reports abort failures so compaction cancellation can be retried', async () => {
  const registry = runtime()
  registry.abort.mockRejectedValueOnce(new Error('RPC unavailable'))
  const broker = createBroker(registry)
  const client = socket()
  broker.open(client)
  await broker.message(client, JSON.stringify({ id: 'w', sessionId: 'session-1', type: 'watch' }))
  await broker.message(client, JSON.stringify({ id: 'cancel', sessionId: 'session-1', type: 'abort' }))
  expect(client.sent).toContainEqual({ type: 'error', id: 'cancel', sessionId: 'session-1', code: 'COMMAND_FAILED', message: '取消失败，请重试。' })
})

it('prepares a WebSocket attachment prompt once and delivers the prepared payload once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-ws-attachment-'))
  const host = nativeHost()
  const registry = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: () => host as unknown as PiRuntimeHost })
  const broker = createBroker(registry)
  const client = socket()
  broker.open(client)
  try {
    const image = await registry.attachments.upload(imageStream(), 'session-1', 'photo.png', 'image/png')
    const file = await registry.attachments.upload(textStream('hello'), 'session-1', 'notes.txt', 'text/plain')
    const submissionId = crypto.randomUUID()
    vi.mocked(preparePiImage).mockClear()
    const read = vi.spyOn(registry.attachments, 'read')

    await broker.message(client, JSON.stringify({ id: 'watch', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'prompt', message: 'look', sessionId: 'session-1', type: 'prompt', attachmentIds: [image.id, file.id], submissionId }))

    expect(preparePiImage).toHaveBeenCalledTimes(1)
    expect(read.mock.calls.filter(([id]) => id === image.id)).toHaveLength(1)
    expect(read.mock.calls.filter(([id]) => id === file.id)).toHaveLength(1)
    expect(host.beginPrompt).toHaveBeenCalledTimes(1)
    expect(host.beginPrompt).toHaveBeenCalledWith(expect.stringContaining(submissionId), [{ type: 'image', data: png, mimeType: 'image/png' }])
    expect(client.sent.find((message: any) => message.id === 'prompt')).toMatchObject({ command: 'prompt', data: { runId: expect.any(String) }, sessionId: 'session-1', type: 'ack' })
    read.mockRestore()
  } finally { await registry.close(); await rm(directory, { force: true, recursive: true }) }
})

it('returns an accepted receipt without rereading or reconverting and still rejects changed content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-ws-attachment-receipt-'))
  const host = nativeHost()
  const registry = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: () => host as unknown as PiRuntimeHost })
  const broker = createBroker(registry)
  const client = socket()
  broker.open(client)
  try {
    const image = await registry.attachments.upload(imageStream(), 'session-1', 'photo.png', 'image/png')
    const submissionId = crypto.randomUUID()
    vi.mocked(preparePiImage).mockClear()
    const read = vi.spyOn(registry.attachments, 'read')
    await broker.message(client, JSON.stringify({ id: 'watch', sessionId: 'session-1', type: 'watch' }))
    await broker.message(client, JSON.stringify({ id: 'first', message: 'look', sessionId: 'session-1', type: 'prompt', attachmentIds: [image.id], submissionId }))
    const first = client.sent.find((message: any) => message.id === 'first') as any

    vi.mocked(preparePiImage).mockClear()
    read.mockClear()
    await broker.message(client, JSON.stringify({ id: 'retry', message: 'look', sessionId: 'session-1', type: 'prompt', attachmentIds: [image.id], submissionId }))
    expect(client.sent.find((message: any) => message.id === 'retry')).toMatchObject({ command: 'prompt', data: first.data, sessionId: 'session-1', type: 'ack' })
    expect(preparePiImage).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(host.beginPrompt).toHaveBeenCalledTimes(1)

    await broker.message(client, JSON.stringify({ id: 'changed', message: 'different', sessionId: 'session-1', type: 'prompt', attachmentIds: [image.id], submissionId }))
    expect(client.sent.find((message: any) => message.id === 'changed')).toMatchObject({ code: 'SUBMISSION_CONFLICT', sessionId: 'session-1', type: 'error' })
    expect(preparePiImage).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(host.beginPrompt).toHaveBeenCalledTimes(1)
    read.mockRestore()
  } finally { await registry.close(); await rm(directory, { force: true, recursive: true }) }
})

it('coalesces concurrent duplicate WebSocket attachment prompts into one send', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-ws-attachment-concurrent-'))
  const host = nativeHost()
  const registry = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: () => host as unknown as PiRuntimeHost })
  const broker = createBroker(registry)
  const client = socket()
  broker.open(client)
  try {
    const file = await registry.attachments.upload(textStream('hello'), 'session-1', 'notes.txt', 'text/plain')
    const submissionId = crypto.randomUUID()
    await broker.message(client, JSON.stringify({ id: 'watch', sessionId: 'session-1', type: 'watch' }))
    const prompt = (id: string) => broker.message(client, JSON.stringify({ id, message: 'look', sessionId: 'session-1', type: 'prompt', attachmentIds: [file.id], submissionId }))

    await Promise.all([prompt('one'), prompt('two')])
    expect(host.beginPrompt).toHaveBeenCalledTimes(1)
    expect(client.sent.filter((message: any) => message.type === 'error').every((message: any) => message.code === 'SESSION_BUSY')).toBe(true)
    const accepted = client.sent.find((message: any) => message.type === 'ack' && message.command === 'prompt') as any
    expect(accepted).toMatchObject({ data: { runId: expect.any(String) } })

    await prompt('retry')
    expect(client.sent.find((message: any) => message.id === 'retry')).toMatchObject({ command: 'prompt', data: accepted.data, type: 'ack' })
    expect(host.beginPrompt).toHaveBeenCalledTimes(1)
  } finally { await registry.close(); await rm(directory, { force: true, recursive: true }) }
})

it('rejects forbidden, missing, and corrupted attachments before resuming the runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-ws-attachment-errors-'))
  const host = nativeHost()
  const registry = new PiRuntimeRegistry({ attachmentDirectory: directory, createHost: () => host as unknown as PiRuntimeHost })
  const broker = createBroker(registry)
  const client = socket()
  broker.open(client)
  try {
    const forbidden = await registry.attachments.upload(textStream('secret'), 'other-scope', 'secret.txt', 'text/plain')
    const missing = await registry.attachments.upload(textStream('hello'), 'session-1', 'missing.txt', 'text/plain')
    const corrupt = await registry.attachments.upload(textStream('hello'), 'session-1', 'corrupt.txt', 'text/plain')
    await rm(join(directory, `data-${missing.id}`))
    writeFileSync(join(directory, `data-${corrupt.id}`), 'HELLO')
    const resume = vi.spyOn(registry, 'resume')
    await broker.message(client, JSON.stringify({ id: 'watch', sessionId: 'session-1', type: 'watch' }))
    const prompt = (id: string, attachmentId: string) => broker.message(client, JSON.stringify({ id, message: 'look', sessionId: 'session-1', type: 'prompt', attachmentIds: [attachmentId], submissionId: crypto.randomUUID() }))

    await prompt('forbidden', forbidden.id)
    await prompt('missing', missing.id)
    await prompt('corrupt', corrupt.id)

    expect(client.sent.find((message: any) => message.id === 'forbidden')).toMatchObject({ code: 'ATTACHMENT_FORBIDDEN', type: 'error' })
    expect(client.sent.find((message: any) => message.id === 'missing')).toMatchObject({ code: 'ATTACHMENT_MISSING', type: 'error' })
    expect(client.sent.find((message: any) => message.id === 'corrupt')).toMatchObject({ code: 'ATTACHMENT_CORRUPT', type: 'error' })
    expect(resume).not.toHaveBeenCalled()
    expect(host.beginPrompt).not.toHaveBeenCalled()
    resume.mockRestore()
  } finally { await registry.close(); await rm(directory, { force: true, recursive: true }) }
})


it('routes registered extension submissions separately and refuses attachments', async () => {
  const registry = runtime()
  const broker = createBroker(registry)
  const client = socket()
  broker.open(client)
  await broker.message(client, JSON.stringify({ id: 'w', sessionId: 'session-1', type: 'watch' }))
  await broker.message(client, JSON.stringify({ id: 'ext', sessionId: 'session-1', type: 'extension_command', message: '/ponytail off' }))
  expect(registry.executeExtensionCommand).toHaveBeenCalledWith(nativeBinding, '/ponytail off')
  expect(registry.beginPrompt).not.toHaveBeenCalled()
  expect(client.sent).toContainEqual({ type: 'ack', command: 'extension_command', id: 'ext', sessionId: 'session-1', data: { disposition: 'handled' } })
  await broker.message(client, JSON.stringify({ id: 'bad', sessionId: 'session-1', type: 'extension_command', message: '/ponytail off', attachmentIds: [crypto.randomUUID()] }))
  expect(registry.executeExtensionCommand).toHaveBeenCalledTimes(1)
  expect(client.sent).toContainEqual(expect.objectContaining({ type: 'error', code: 'INVALID_COMMAND', id: 'bad' }))
})

it('reads command metadata while streaming without acquiring the idle mutation lock', async () => {
  const registry = runtime()
  registry.isPromptActive.mockReturnValue(true)
  registry.commandWhileRunning.mockResolvedValue({ data: { commands: [{ name: 'ponytail', source: 'extension' }] } } as never)
  const broker = createBroker(registry)
  const client = socket()
  broker.open(client)
  await broker.message(client, JSON.stringify({ id: 'w', sessionId: 'session-1', type: 'watch' }))
  await broker.message(client, JSON.stringify({ id: 'list', sessionId: 'session-1', type: 'get_commands' }))
  expect(registry.commandWhenIdle).not.toHaveBeenCalled()
  expect(client.sent).toContainEqual(expect.objectContaining({ id: 'list', type: 'ack', data: { commands: [{ name: 'ponytail', source: 'extension' }] } }))
})
