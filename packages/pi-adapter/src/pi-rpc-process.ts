import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { editRecord, pendingPiEdit, piEditRecoveryRecord, piEditStatus, readPiEditEntries, sessionEditCommand } from './session-edit.js'
import { dirname, join, resolve } from 'node:path'
import { getPackageDir } from '@earendil-works/pi-coding-agent'

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
  // The Unix default is resolved relative to the production dist/src module.
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
    const useNode = options.piExecutable === undefined && process.platform === 'win32'
    const extension = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './file-change-extension.ts' : './file-change-extension.js', import.meta.url))
    const editExtension = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './session-edit-extension.ts' : './session-edit-extension.js', import.meta.url))
    const args = ['--mode', 'rpc', '--session', options.sessionFile, '--extension', extension, '--extension', editExtension]
    const connectionOptions: PiRpcConnectionOptions = {
      cwd: options.cwd,
      executable: options.piExecutable ?? (useNode ? process.execPath : defaultPiExecutable()),
      // Windows cannot execute the Unix .bin/pi shim directly.
      args: useNode ? [join(getPackageDir(), 'dist/bundle/cli.js'), ...args] : args,
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

    try {
      if (existsSync(this.options.sessionFile)) piEditRecoveryRecord(readPiEditEntries(this.options.sessionFile))
    } catch (cause) { throw new Error('Failed to start Pi RPC process', { cause }) }

    await this.connection.start()
    try {
      const state = stateFrom(await this.connection.send({ type: 'get_state' }))
      if (typeof state.sessionId !== 'string') throw new Error('Pi RPC get_state response did not contain a sessionId')
      if (state.sessionId !== this.options.expectedSessionId) {
        throw new Error('Pi RPC session ID did not match the server-resolved session')
      }
      this.started = true
      if (existsSync(this.options.sessionFile) && pendingPiEdit(readPiEditEntries(this.options.sessionFile))) await this.send({ type: 'pi_nest_edit', action: 'recover' })
      return { sessionId: state.sessionId, state }
    } catch (cause) {
      await this.connection.close()
      throw new Error('Failed to start Pi RPC process', { cause })
    }
  }

  async send(command: PiRpcRecord) {
    if (!this.started) throw new Error('Pi RPC process is not started')
    if (command.type === 'pi_nest_edit') {
      const { type: _type, ...input } = command
      await this.connection.send({ type: 'prompt', message: `/${sessionEditCommand} ${JSON.stringify(input)}` })
      const entries = readPiEditEntries(this.options.sessionFile)
      if (input.action === 'recover' && pendingPiEdit(entries)) throw new Error('EDIT_RECOVERY_REQUIRED: Pi edit recovery did not finish')
      const record = entries.findLast((entry) => editRecord(entry)?.submissionId === input.submissionId)
      return { type: 'response' as const, success: true, command: 'pi_nest_edit', data: { ...(typeof input.submissionId === 'string' ? piEditStatus(entries, input.submissionId) : {}), phase: record && editRecord(record)?.phase } }
    }
    if (typeof command.message === 'string' && command.message.trimStart().startsWith(`/${sessionEditCommand}`)) throw new Error('Internal session command is unavailable')
    const response = await this.connection.send(command)
    if (command.type === 'get_commands' && response.data && typeof response.data === 'object') {
      const data = response.data as { commands?: { name: string }[] }
      if (Array.isArray(data.commands)) return { ...response, data: { ...data, commands: data.commands.filter((item) => item.name !== sessionEditCommand) } }
    }
    return response
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
