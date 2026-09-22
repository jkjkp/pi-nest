import { listPiSessions } from '@pi-nest/pi-adapter'
import { z } from 'zod'

import type { PiRuntimeEvent, PiRuntimeSession } from './pi-runtime-host.js'
import { PiRuntimeRegistry } from './pi-runtime-registry.js'
import { PiRuntimeResumeError } from './session-event-stream.js'

const commandSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1).max(128), resume: z.object({ after: z.number().int().nonnegative() }).strict().optional(), sessionId: z.string().min(1), type: z.literal('attach') }).strict(),
  z.object({ id: z.string().min(1).max(128), message: z.string().trim().min(1).max(20_000), sessionId: z.string().min(1), type: z.literal('prompt') }).strict(),
  z.object({ id: z.string().min(1).max(128), sessionId: z.string().min(1), type: z.literal('abort') }).strict(),
  z.object({ id: z.string().min(1).max(128), message: z.string().trim().min(1).max(20_000), sessionId: z.string().min(1), type: z.literal('steer') }).strict(),
  z.object({ id: z.string().min(1).max(128), message: z.string().trim().min(1).max(20_000), sessionId: z.string().min(1), type: z.literal('follow_up') }).strict(),
  z.object({ id: z.string().min(1).max(128), provider: z.string().min(1).max(256), modelId: z.string().min(1).max(256), sessionId: z.string().min(1), type: z.literal('set_model') }).strict(),
  z.object({ id: z.string().min(1).max(128), level: z.string().min(1).max(64), sessionId: z.string().min(1), type: z.literal('set_thinking_level') }).strict(),
  z.object({ id: z.string().min(1).max(128), sessionId: z.string().min(1), type: z.literal('compact') }).strict(),
  z.object({ id: z.string().min(1).max(128), sessionId: z.string().min(1), type: z.literal('get_runtime_state') }).strict(),
  z.object({ id: z.string().min(1).max(128), sessionId: z.string().min(1), type: z.literal('get_available_models') }).strict(),
  z.object({ id: z.string().min(1).max(128), sessionId: z.string().min(1), type: z.literal('get_available_thinking_levels') }).strict(),
  z.object({ id: z.string().min(1).max(128), sessionId: z.string().min(1), type: z.literal('extension_ui_response'), value: z.unknown().optional(), confirmed: z.boolean().optional(), cancelled: z.boolean().optional(), dialogId: z.string().min(1).max(256) }).strict(),
])

type RuntimeSocket = { send: (data: string) => void }
type AttachedSession = { after: number; session: PiRuntimeSession; unsubscribe: () => void }
type SocketState = { sessions: Map<string, AttachedSession> }

function serialize(value: unknown) {
  return JSON.stringify(value)
}

/** Maps one browser WebSocket to zero or more native Pi Session subscriptions. */
export class RuntimeWebSocketBroker {
  private readonly sockets = new Map<RuntimeSocket, SocketState>()

  constructor(private readonly runtime: PiRuntimeRegistry) {}

  open(socket: RuntimeSocket) {
    this.sockets.set(socket, { sessions: new Map() })
  }

  close(socket: RuntimeSocket) {
    const state = this.sockets.get(socket)
    if (!state) return
    for (const attached of state.sessions.values()) attached.unsubscribe()
    this.sockets.delete(socket)
  }

  async message(socket: RuntimeSocket, data: unknown) {
    const state = this.sockets.get(socket)
    if (!state) return
    if (typeof data !== 'string') return this.error(socket, undefined, 'INVALID_COMMAND', 'WebSocket commands must be text JSON')

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return this.error(socket, undefined, 'INVALID_COMMAND', 'WebSocket command must be valid JSON')
    }
    const command = commandSchema.safeParse(parsed)
    const invalidId = parsed && typeof parsed === 'object' && typeof (parsed as { id?: unknown }).id === 'string'
      ? (parsed as { id: string }).id
      : undefined
    if (!command.success) return this.error(socket, invalidId, 'INVALID_COMMAND', 'Invalid WebSocket command')

    if (command.data.type === 'attach') return this.attach(socket, state, command.data)
    const attached = state.sessions.get(command.data.sessionId)
    if (!attached) return this.error(socket, command.data.id, 'SESSION_NOT_ATTACHED', 'Pi session is not attached', command.data.sessionId)

    if (command.data.type === 'abort') {
      if (!(await this.runtime.abort(command.data.sessionId))) return this.error(socket, command.data.id, 'SESSION_NOT_RUNNING', 'Pi session is not running', command.data.sessionId)
      return this.ack(socket, command.data.id, command.data.type, command.data.sessionId)
    }

    if (command.data.type === 'steer' || command.data.type === 'follow_up') {
      try {
        const result = await this.runtime.commandWhileRunning(command.data.sessionId, { type: command.data.type, message: command.data.message })
        if (!result) return this.error(socket, command.data.id, 'SESSION_NOT_RUNNING', 'Pi session is not running', command.data.sessionId)
        return this.ack(socket, command.data.id, command.data.type, command.data.sessionId)
      } catch {
        return this.error(socket, command.data.id, 'COMMAND_FAILED', 'Pi runtime command failed', command.data.sessionId)
      }
    }

    if (command.data.type === 'extension_ui_response') {
      try {
        const result = await this.runtime.respondToExtension(command.data.sessionId, {
          ...(command.data.cancelled ? { cancelled: true } : {}),
          ...(command.data.confirmed === undefined ? {} : { confirmed: command.data.confirmed }),
          ...(command.data.value === undefined ? {} : { value: command.data.value }),
          id: command.data.dialogId,
          type: 'extension_ui_response',
        })
        if (!result) return this.error(socket, command.data.id, 'EXTENSION_UI_NOT_PENDING', 'Pi extension dialog is not pending', command.data.sessionId)
        return this.ack(socket, command.data.id, command.data.type, command.data.sessionId)
      } catch {
        return this.error(socket, command.data.id, 'COMMAND_FAILED', 'Pi runtime command failed', command.data.sessionId)
      }
    }

    if (command.data.type === 'get_runtime_state' || command.data.type === 'get_available_models' || command.data.type === 'get_available_thinking_levels' || command.data.type === 'set_model' || command.data.type === 'set_thinking_level' || command.data.type === 'compact') {
      const rpc = command.data.type === 'set_model'
        ? { type: 'set_model', provider: command.data.provider, modelId: command.data.modelId }
        : command.data.type === 'set_thinking_level'
          ? { type: 'set_thinking_level', level: command.data.level }
          : { type: command.data.type }
      try {
        const result = this.runtime.commandWhenIdle(attached.session, rpc)
        if (!result) return this.error(socket, command.data.id, 'SESSION_BUSY', 'Pi session is busy', command.data.sessionId)
        const response = await result
        return this.ack(socket, command.data.id, command.data.type, command.data.sessionId, this.safeData(command.data.type, response))
      } catch {
        return this.error(socket, command.data.id, 'COMMAND_FAILED', 'Pi runtime command failed', command.data.sessionId)
      }
    }

    const prompt = this.runtime.startPrompt(attached.session, command.data.message)
    if (!prompt) return this.error(socket, command.data.id, 'SESSION_BUSY', 'Pi session is already running', command.data.sessionId)
    this.ack(socket, command.data.id, command.data.type, command.data.sessionId)
    void prompt.catch(() => this.error(socket, command.data.id, 'PROMPT_FAILED', 'Pi session prompt failed', command.data.sessionId))
  }

  private async attach(socket: RuntimeSocket, state: SocketState, command: { id: string; resume?: { after: number }; sessionId: string }) {
    const after = command.resume?.after ?? 0
    const current = state.sessions.get(command.sessionId)
    if (current?.after === after) return this.ack(socket, command.id, 'attach', command.sessionId)
    let session
    try {
      session = (await listPiSessions()).find((candidate) => candidate.id === command.sessionId)
    } catch {
      return this.error(socket, command.id, 'SESSION_UNAVAILABLE', 'Failed to resolve Pi session', command.sessionId)
    }
    if (!session) return this.error(socket, command.id, 'SESSION_NOT_FOUND', 'Pi session not found', command.sessionId)
    if (!session.cwd) return this.error(socket, command.id, 'SESSION_UNAVAILABLE', 'Pi session cwd is unavailable', command.sessionId)

    current?.unsubscribe()
    state.sessions.delete(session.id)
    let unsubscribe
    try {
      unsubscribe = await this.runtime.subscribe(
        session.id,
        after,
        (event) => this.event(socket, event),
        (error) => this.error(socket, undefined, error.code, error.message, session.id),
      )
    } catch (cause) {
      if (cause instanceof PiRuntimeResumeError) return this.error(socket, command.id, cause.code, cause.message, session.id)
      return this.error(socket, command.id, 'EVENT_BUFFER_FAILED', 'Pi runtime event buffer failed', session.id)
    }
    state.sessions.set(session.id, {
      after,
      session: { cwd: session.cwd, id: session.id, sessionFile: session.sessionFile },
      unsubscribe,
    })
    this.ack(socket, command.id, 'attach', session.id)
  }

  private ack(socket: RuntimeSocket, id: string, command: string, sessionId: string, data?: unknown) {
    this.send(socket, { ...(data === undefined ? {} : { data }), command, id, sessionId, type: 'ack' })
  }

  private error(socket: RuntimeSocket, id: string | undefined, code: string, message: string, sessionId?: string) {
    this.send(socket, { ...(id ? { id } : {}), ...(sessionId ? { sessionId } : {}), code, message, type: 'error' })
  }

  private event(socket: RuntimeSocket, event: PiRuntimeEvent) {
    this.send(socket, { ...event, type: 'pi_event' })
  }

  private send(socket: RuntimeSocket, message: unknown) {
    try {
      socket.send(serialize(message))
    } catch {
      this.close(socket)
    }
  }

  private safeData(command: string, response: Record<string, unknown> | undefined) {
    const data = response?.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
    const value = data as Record<string, unknown>
    if (command === 'get_runtime_state') {
      const model = value.model
      const safeModel = model && typeof model === 'object' && !Array.isArray(model)
        ? { id: typeof (model as Record<string, unknown>).id === 'string' ? (model as Record<string, unknown>).id : undefined, provider: typeof (model as Record<string, unknown>).provider === 'string' ? (model as Record<string, unknown>).provider : undefined }
        : undefined
      return {
        followUpMode: typeof value.followUpMode === 'string' ? value.followUpMode : undefined,
        isCompacting: value.isCompacting === true,
        isStreaming: value.isStreaming === true,
        model: safeModel,
        steeringMode: typeof value.steeringMode === 'string' ? value.steeringMode : undefined,
        thinkingLevel: typeof value.thinkingLevel === 'string' ? value.thinkingLevel : undefined,
      }
    }
    if (command === 'get_available_models') {
      const models = Array.isArray(value.models) ? value.models : []
      return { models: models.flatMap((model) => model && typeof model === 'object' && !Array.isArray(model) && typeof (model as Record<string, unknown>).id === 'string' && typeof (model as Record<string, unknown>).provider === 'string' ? [{ id: (model as Record<string, unknown>).id, name: typeof (model as Record<string, unknown>).name === 'string' ? (model as Record<string, unknown>).name : undefined, provider: (model as Record<string, unknown>).provider }] : []) }
    }
    if (command === 'get_available_thinking_levels') return { levels: Array.isArray(value.levels) ? value.levels.filter((level): level is string => typeof level === 'string') : [] }
    return undefined
  }
}
