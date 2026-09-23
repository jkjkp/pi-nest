import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  PiRpcConnection,
  type PiRpcConnectionError,
  type PiRpcConnectionOptions,
  type PiRpcRecord,
  type PiRpcResponse,
  type SpawnRpcProcess,
} from './pi-rpc-connection.js'

export type PiRpcProcessOptions = {
  cwd: string
  expectedSessionId: string
  piExecutable?: string
  sessionFile: string
  spawnProcess?: SpawnRpcProcess
}

export type PiRpcProcessState = {
  sessionId: string
  state: PiRpcRecord
}

function defaultPiExecutable() {
  // This module is executed from dist/src in production. Tests inject the
  // executable so they do not depend on this build-output location.
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'node_modules/.bin/pi')
}

function stateFrom(response: PiRpcResponse): PiRpcRecord {
  if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
    throw new Error('Pi RPC get_state response did not contain an object')
  }
  return response.data as PiRpcRecord
}

/**
 * Server-side holder for one native Pi CLI RPC process. It owns neither a
 * browser connection nor Session discovery; callers supply a resolved session.
 */
export class PiRpcProcess {
  private readonly connection: PiRpcConnection
  private started = false

  constructor(private readonly options: PiRpcProcessOptions) {
    const connectionOptions: PiRpcConnectionOptions = {
      cwd: options.cwd,
      executable: options.piExecutable ?? defaultPiExecutable(),
      sessionFile: options.sessionFile,
      spawnProcess: options.spawnProcess,
    }
    this.connection = new PiRpcConnection(connectionOptions)
  }

  get stderrText() {
    return this.connection.stderrText
  }

  onEvent(listener: (record: PiRpcRecord) => void) {
    return this.connection.onRecord(listener)
  }

  onFailure(listener: (error: PiRpcConnectionError) => void) {
    return this.connection.onFailure(listener)
  }

  async start(): Promise<PiRpcProcessState> {
    if (this.started) throw new Error('Pi RPC process is already started')

    await this.connection.start()
    try {
      const state = stateFrom(await this.connection.send({ type: 'get_state' }))
      if (typeof state.sessionId !== 'string') throw new Error('Pi RPC get_state response did not contain a sessionId')
      if (state.sessionId !== this.options.expectedSessionId) {
        throw new Error('Pi RPC session ID did not match the server-resolved session')
      }
      this.started = true
      return { sessionId: state.sessionId, state }
    } catch (cause) {
      await this.connection.close()
      throw new Error('Failed to start Pi RPC process', { cause })
    }
  }

  send(command: PiRpcRecord) {
    if (!this.started) throw new Error('Pi RPC process is not started')
    return this.connection.send(command)
  }

  write(record: PiRpcRecord) {
    if (!this.started) throw new Error('Pi RPC process is not started')
    this.connection.write(record)
  }

  async close() {
    this.started = false
    await this.connection.close()
  }
}
