import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { SessionManager } from '@earendil-works/pi-coding-agent'

import { PiRpcConnection, type PiRpcRecord } from './pi-rpc-connection.js'

const executeFile = promisify(execFile)
const timeoutMs = 120_000
const piCliVersion = '0.86.0'

export type PiRpcCapabilityStatus = 'passed' | 'blocked' | 'not_applicable'
export type PiRpcCompatibilityReport = {
  capabilities: Record<string, { detail: string; status: PiRpcCapabilityStatus }>
  cliVersion: string
  eventTypes: string[]
  outcome: 'passed' | 'blocked'
  session: { entryTypes: string[]; id: string; path: string; sha256: string; size: number }
}

type SpikeOptions = {
  cwd: string
  piExecutable: string
  sessionFile?: string
}

function snapshot(sessionFile: string) {
  const content = readFileSync(sessionFile)
  const manager = SessionManager.open(sessionFile)
  return {
    entryTypes: [...new Set(manager.getEntries().map((entry) => entry.type))].sort(),
    id: manager.getSessionId(),
    path: sessionFile,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: statSync(sessionFile).size,
  }
}

function sessionEvidence(sessionFile: string, fallbackId: string) {
  if (existsSync(sessionFile)) return snapshot(sessionFile)
  return { entryTypes: [], id: fallbackId, path: sessionFile, sha256: 'not-persisted', size: 0 }
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} was not an object`)
  return value as Record<string, any>
}

function matches(record: PiRpcRecord, type: string) {
  return record.type === type
}

async function runNormalCli(piExecutable: string, cwd: string, sessionFile: string) {
  const execution = executeFile(piExecutable, [
    '--approve',
    '--session',
    sessionFile,
    '--print',
    'Reply with exactly PI_NEST_RPC_CLI_CONTINUITY_OK and no other text.',
  ], { cwd, maxBuffer: 1024 * 1024, timeout: 300_000 })
  execution.child.stdin?.end()
  const { stdout } = await execution
  if (String(stdout).trim() !== 'PI_NEST_RPC_CLI_CONTINUITY_OK') {
    throw new Error('Normal Pi CLI did not continue the dedicated native session')
  }
}

/**
 * Runs only against the repository fixture. Terminal-only custom component UI
 * is intentionally outside Pi Nest's supported RPC interaction scope.
 */
export async function runPiRpcCompatibilitySpike(options: SpikeOptions): Promise<PiRpcCompatibilityReport> {
  const manager = options.sessionFile ? undefined : SessionManager.create(options.cwd)
  const sessionFile = options.sessionFile ?? manager?.getSessionFile()
  if (!sessionFile) throw new Error('Pi SDK did not create a dedicated test session')

  const tempDir = mkdtempSync(join(tmpdir(), 'pi-nest-rpc-spike-'))
  chmodSync(tempDir, 0o700)
  const rawLog = join(tempDir, 'stdout.jsonl')
  const records: PiRpcRecord[] = []
  const capabilities: PiRpcCompatibilityReport['capabilities'] = {}
  let blocked = false
  const mark = (name: string, status: PiRpcCapabilityStatus, detail: string) => {
    capabilities[name] = { status, detail }
    if (status === 'blocked') blocked = true
  }

  const connection = new PiRpcConnection({
    args: ['--mode', 'rpc', '--approve', '--session', sessionFile],
    commandTimeoutMs: timeoutMs,
    cwd: options.cwd,
    executable: options.piExecutable,
    sessionFile,
  })
  const waitFor = (predicate: (record: PiRpcRecord) => boolean, description: string) =>
    new Promise<PiRpcRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Missing Pi RPC event: ${description}`))
      }, timeoutMs)
      const unsubscribe = connection.onRecord((record) => {
        if (!predicate(record)) return
        clearTimeout(timer)
        unsubscribe()
        resolve(record)
      })
    })
  const waitForSettled = () => waitFor((record) => matches(record, 'agent_settled'), 'agent_settled')
  const lastAssistantText = async () => {
    const response = await connection.send({ type: 'get_last_assistant_text' })
    return String(object(response.data, 'last assistant text data').text ?? '')
  }
  const promptAndSettle = async (message: string) => {
    const settled = waitForSettled()
    await connection.send({ type: 'prompt', message })
    await settled
  }

  try {
    connection.onRecord((record) => {
      records.push(record)
      appendFileSync(rawLog, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      if (record.type !== 'extension_ui_request' || typeof record.id !== 'string') return
      switch (record.method) {
        case 'select':
          connection.write({ type: 'extension_ui_response', id: record.id, value: 'fixture-choice' })
          break
        case 'confirm':
          connection.write({ type: 'extension_ui_response', id: record.id, confirmed: true })
          break
        case 'input':
          connection.write({ type: 'extension_ui_response', id: record.id, value: 'fixture-input' })
          break
        case 'editor':
          connection.write({ type: 'extension_ui_response', id: record.id, value: 'fixture-editor' })
          break
      }
    })
    await connection.start()

    const state = object((await connection.send({ type: 'get_state' })).data, 'get_state data')
    if (state.sessionFile !== sessionFile || typeof state.sessionId !== 'string') throw new Error('RPC did not bind the requested native session')
    const sessionId = state.sessionId
    const commands = object((await connection.send({ type: 'get_commands' })).data, 'get_commands data').commands
    const commandNames = new Set(Array.isArray(commands) ? commands.map((command) => object(command, 'command').name) : [])
    for (const name of ['rpc-fixture-template', 'skill:rpc-fixture-skill', 'rpc-fixture-command']) {
      if (!commandNames.has(name)) throw new Error(`Pi RPC did not discover fixture resource: ${name}`)
    }
    mark('resources', 'passed', 'Session, prompt template, skill, and extension command were discovered by Pi CLI.')

    const models = object((await connection.send({ type: 'get_available_models' })).data, 'models data').models
    if (!Array.isArray(models) || models.length < 2) {
      mark('model_and_thinking', 'blocked', 'At least two distinct Pi models are required; no same-model downgrade is allowed.')
      return report(blocked, capabilities, records, options.piExecutable, sessionEvidence(sessionFile, sessionId))
    }
    const currentKey = `${state.model?.provider}/${state.model?.id}`
    const alternate = models.find((model) => `${model.provider}/${model.id}` !== currentKey)
    if (!alternate) {
      mark('model_and_thinking', 'blocked', 'Pi reported fewer than two distinct usable models.')
      return report(blocked, capabilities, records, options.piExecutable, sessionEvidence(sessionFile, sessionId))
    }
    await connection.send({ type: 'set_model', provider: alternate.provider, modelId: alternate.id })
    const levels = object((await connection.send({ type: 'get_available_thinking_levels' })).data, 'thinking levels data').levels
    if (!Array.isArray(levels) || levels.length < 2) {
      mark('model_and_thinking', 'blocked', 'The selected alternate model has fewer than two thinking levels.')
      return report(blocked, capabilities, records, options.piExecutable, snapshot(sessionFile))
    }
    const level = levels.find((item) => item !== state.thinkingLevel) ?? levels[1]
    await connection.send({ type: 'set_thinking_level', level })
    const changed = object((await connection.send({ type: 'get_state' })).data, 'changed state')
    if (changed.model?.provider !== alternate.provider || changed.model?.id !== alternate.id || changed.thinkingLevel !== level) {
      throw new Error('set_model or set_thinking_level did not update Pi native state')
    }
    mark('model_and_thinking', 'passed', 'A distinct model and another supported thinking level were selected through RPC.')

    const contextLoaded = waitFor((record) => record.type === 'extension_ui_request' && record.message === 'PI_NEST_RPC_CONTEXT_LOADED', 'context load notification')
    await promptAndSettle('Reply with exactly PI_NEST_RPC_CONTEXT_OK and no other text.')
    await contextLoaded
    if ((await lastAssistantText()).trim() !== 'PI_NEST_RPC_CONTEXT_OK') throw new Error('AGENTS.md fixture was not observed by the model')
    await promptAndSettle('/rpc-fixture-template')
    if ((await lastAssistantText()).trim() !== 'PI_NEST_RPC_TEMPLATE_OK') throw new Error('Prompt template did not expand through Pi RPC')
    await promptAndSettle('/skill:rpc-fixture-skill')
    if ((await lastAssistantText()).trim() !== 'PI_NEST_RPC_SKILL_OK') throw new Error('Skill did not expand through Pi RPC')
    mark('context_template_skill', 'passed', 'AGENTS.md, prompt template, and skill produced their fixture sentinels.')

    const toolStart = waitFor((record) => record.type === 'tool_execution_start' && record.toolName === 'rpc_fixture_tool', 'custom tool start')
    const toolUpdate = waitFor((record) => record.type === 'tool_execution_update' && record.toolName === 'rpc_fixture_tool', 'custom tool update')
    const toolEnd = waitFor((record) => record.type === 'tool_execution_end' && record.toolName === 'rpc_fixture_tool', 'custom tool end')
    await promptAndSettle('Use rpc_fixture_tool exactly once with marker PI_NEST_RPC_TOOL_OK. Do not answer until it completes.')
    await Promise.all([toolStart, toolUpdate, toolEnd])
    mark('extension_tool', 'passed', 'The model invoked the fixture custom extension tool with start, update, and end events.')

    const bashUpdate = waitFor((record) => record.type === 'bash_execution_update', 'bash stdout/stderr update')
    const bash = await connection.send({ type: 'bash', command: 'printf PI_NEST_RPC_BASH_OK' })
    await bashUpdate
    if (object(bash.data, 'bash result').exitCode !== 0) throw new Error('RPC bash did not return exit code 0')
    mark('bash', 'passed', 'RPC bash emitted a live update and returned an exit result in the fixture cwd.')

    const uiComplete = waitFor((record) => record.type === 'extension_ui_request' && record.message === 'PI_NEST_RPC_UI_COMPLETE', 'extension UI completion')
    await connection.send({ type: 'prompt', message: '/rpc-fixture-ui' })
    await uiComplete
    mark('extension_ui', 'passed', 'select, confirm, input, and editor requests accepted extension_ui_response values.')

    const customUi = waitFor((record) => record.type === 'extension_ui_request' && typeof record.message === 'string' && record.message.startsWith('PI_NEST_RPC_CUSTOM_'), 'custom UI probe')
    await connection.send({ type: 'prompt', message: '/rpc-fixture-unsupported-ui' })
    const customUiResult = await customUi
    if (customUiResult.message === 'PI_NEST_RPC_CUSTOM_UNSUPPORTED') {
      mark('custom_extension_ui', 'not_applicable', 'Pi RPC returned undefined for extension ui.custom(); terminal-only custom component UI is explicitly out of scope.')
    } else {
      mark('custom_extension_ui', 'not_applicable', 'Terminal-only custom component UI is explicitly out of scope, even though this Pi version represented the probe.')
    }

    // Pi retains 20k recent tokens before manual compaction. A fixture-local
    // bash result supplies deterministic, non-sensitive context without asking
    // the model to generate a costly long response.
    for (let index = 0; index < 3; index += 1) {
      const compactionFixtureBash = await connection.send({
        type: 'bash',
        command: "node -e 'process.stdout.write(\"x\".repeat(100000))'",
      })
      if (object(compactionFixtureBash.data, 'compaction fixture bash result').exitCode !== 0) {
        throw new Error('Could not create the fixture-local context required for manual compaction')
      }
    }
    const compactStart = waitFor((record) => matches(record, 'compaction_start'), 'compaction_start')
    const compactEnd = waitFor((record) => matches(record, 'compaction_end'), 'compaction_end')
    await connection.send({ type: 'compact' })
    await Promise.all([compactStart, compactEnd])
    mark('compact', 'passed', 'RPC emitted compaction start and end events.')

    const firstText = waitFor(
      (record) => record.type === 'message_update' && object(record.assistantMessageEvent, 'assistant update').type === 'text_delta',
      'first assistant text delta',
    )
    await connection.send({ type: 'prompt', message: 'Count from 1 to 10000 slowly, one number per line.' })
    await firstText
    const abortSettled = waitForSettled()
    await connection.send({ type: 'abort' })
    await abortSettled
    if ((await lastAssistantText()).length === 0) throw new Error('abort discarded already-streamed assistant text')
    mark('abort', 'passed', 'Abort followed the first text delta and retained the partial assistant output.')
    await connection.close()

    await runNormalCli(options.piExecutable, options.cwd, sessionFile)
    const resumed = new PiRpcConnection({
      args: ['--mode', 'rpc', '--approve', '--session', sessionFile],
      cwd: options.cwd,
      executable: options.piExecutable,
      sessionFile,
    })
    resumed.onRecord((record) => {
      records.push(record)
      appendFileSync(rawLog, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    })
    await resumed.start()
    const resumedState = object((await resumed.send({ type: 'get_state' })).data, 'resumed state')
    await resumed.close()
    if (resumedState.sessionId !== sessionId) throw new Error('RPC did not resume the CLI-continuous native session')
    mark('cli_rpc_cli', 'passed', 'Normal CLI and a fresh RPC process continued the same dedicated session.')

    return report(blocked, capabilities, records, options.piExecutable, snapshot(sessionFile))
  } finally {
    await connection.close()
    rmSync(tempDir, { force: true, recursive: true })
  }
}

function report(
  blocked: boolean,
  capabilities: PiRpcCompatibilityReport['capabilities'],
  records: PiRpcRecord[],
  piExecutable: string,
  session: PiRpcCompatibilityReport['session'],
): PiRpcCompatibilityReport {
  return {
    capabilities,
    cliVersion: piCliVersion,
    eventTypes: [...new Set(records.map((record) => String(record.type)))],
    outcome: blocked ? 'blocked' : 'passed',
    session,
  }
}
