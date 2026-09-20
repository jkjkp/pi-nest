import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { promisify } from 'node:util'

import { SessionManager } from '@earendil-works/pi-coding-agent'

import { createRestrictedAgentSession } from './create-restricted-agent-session.js'

const executeFile = promisify(execFile)

export const CLI_TO_SDK_RESPONSE = 'CLI_TO_SDK_OK'
export const SDK_TO_CLI_RESPONSE = 'SDK_TO_CLI_OK'
export const CLI_SDK_VISIBLE_RESPONSE = 'CLI_SDK_VISIBLE'

const CLI_TO_SDK_PROMPT = `Reply with exactly ${CLI_TO_SDK_RESPONSE} and no other text.`
const SDK_TO_CLI_PROMPT = `Reply with exactly ${SDK_TO_CLI_RESPONSE} and no other text.`
const CLI_SDK_VISIBLE_PROMPT = `Reply with exactly ${CLI_SDK_VISIBLE_RESPONSE} if the immediately preceding assistant reply was ${SDK_TO_CLI_RESPONSE}. Otherwise reply CLI_SDK_MISSING.`

export type PiSessionSnapshot = {
  cwd: string | undefined
  hash: string
  id: string
  leafId: string | undefined
  messageCount: number
  size: number
}

export type PiSdkContinuationSummary = {
  messageCountAfter: number
  messageCountBefore: number
  model: { id: string; provider: string } | undefined
  modelRestoreWarning: string | undefined
  toolEventCount: number
}

export type PiCliSdkCliSpikeSummary = {
  afterCliToSdk: PiSessionSnapshot
  afterSdkToCli: PiSessionSnapshot
  afterVerificationCli: PiSessionSnapshot
  baseline: PiSessionSnapshot
  sdk: PiSdkContinuationSummary
}

type CliRunner = (args: string[]) => Promise<string>
type SessionSnapshotReader = (sessionFile: string) => PiSessionSnapshot
type SdkRunner = (
  sessionFile: string,
  cwd: string,
  expectedPriorResponse: string,
  prompt: string,
  expectedResponse: string,
) => Promise<PiSdkContinuationSummary>

function fingerprint(sessionFile: string) {
  const content = readFileSync(sessionFile)

  return {
    hash: createHash('sha256').update(content).digest('hex'),
    size: statSync(sessionFile).size,
  }
}

export function readPiSessionSnapshot(sessionFile: string): PiSessionSnapshot {
  try {
    const before = fingerprint(sessionFile)
    const sessionManager = SessionManager.open(sessionFile)
    const after = fingerprint(sessionFile)

    if (before.hash !== after.hash || before.size !== after.size) {
      throw new Error('Pi SDK changed the session during compatibility preflight')
    }

    return {
      cwd: sessionManager.getHeader()?.cwd || undefined,
      hash: before.hash,
      id: sessionManager.getSessionId(),
      leafId: sessionManager.getLeafId() || undefined,
      messageCount: sessionManager.getEntries().filter((entry) => entry.type === 'message').length,
      size: before.size,
    }
  } catch (cause) {
    throw new Error(`Failed to inspect Pi session: ${sessionFile}`, { cause })
  }
}

export function buildRestrictedCliArgs(sessionFile: string, prompt: string) {
  return [
    '--session',
    sessionFile,
    '--print',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    prompt,
  ]
}

export async function runPiCli(
  piExecutable: string,
  cwd: string,
  args: string[],
  execute: typeof executeFile = executeFile,
) {
  const execution = execute(piExecutable, args, {
    cwd,
    maxBuffer: 1024 * 1024,
    timeout: 300_000,
  })
  execution.child.stdin?.end()

  const { stdout } = await execution

  return String(stdout).trim()
}

function assertAdvanced(before: PiSessionSnapshot, after: PiSessionSnapshot, phase: string) {
  if (
    before.id !== after.id ||
    before.cwd !== after.cwd ||
    before.hash === after.hash ||
    before.size >= after.size ||
    before.messageCount >= after.messageCount ||
    before.leafId === after.leafId
  ) {
    throw new Error(`Pi session did not advance after ${phase}`)
  }
}

export async function runPiSdkContinuation(
  sessionFile: string,
  cwd: string,
  expectedPriorResponse: string,
  prompt: string,
  expectedResponse: string,
): Promise<PiSdkContinuationSummary> {
  try {
    const sessionManager = SessionManager.open(sessionFile)
    const header = sessionManager.getHeader()
    const openedSessionFile = sessionManager.getSessionFile()

    if (!header || header.cwd !== cwd || openedSessionFile !== sessionFile) {
      throw new Error('Pi SDK did not open the requested native session in the expected cwd')
    }

    const { session, modelFallbackMessage } = await createRestrictedAgentSession(sessionManager, cwd)
    let toolEventCount = 0
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === 'tool_execution_start' ||
        event.type === 'tool_execution_update' ||
        event.type === 'tool_execution_end'
      ) {
        toolEventCount += 1
      }
    })

    try {
      if (session.sessionId !== sessionManager.getSessionId() || session.sessionFile !== sessionFile) {
        throw new Error('Pi SDK did not keep the AgentSession bound to the requested native session')
      }

      if (session.getLastAssistantText() !== expectedPriorResponse) {
        throw new Error('Pi SDK did not restore the CLI response as the current session context')
      }

      const messageCountBefore = session.messages.length
      await session.prompt(prompt)

      if (session.getLastAssistantText() !== expectedResponse) {
        throw new Error('Pi SDK did not produce the expected continuation response')
      }

      if (toolEventCount !== 0) {
        throw new Error('Pi SDK emitted tool events despite tools being disabled')
      }

      return {
        messageCountAfter: session.messages.length,
        messageCountBefore,
        model: session.model && { id: session.model.id, provider: session.model.provider },
        modelRestoreWarning: modelFallbackMessage,
        toolEventCount,
      }
    } finally {
      unsubscribe()
      session.dispose()
    }
  } catch (cause) {
    throw new Error(`Failed to continue Pi session through SDK: ${sessionFile}`, { cause })
  }
}

export async function runPiCliSdkCliSpike({
  cwd,
  piExecutable,
  sessionFile,
  runCli,
  runSdk = runPiSdkContinuation,
  snapshot = readPiSessionSnapshot,
}: {
  cwd: string
  piExecutable: string
  sessionFile: string
  runCli?: CliRunner
  runSdk?: SdkRunner
  snapshot?: SessionSnapshotReader
}): Promise<PiCliSdkCliSpikeSummary> {
  try {
    const baseline = snapshot(sessionFile)

    if (baseline.cwd !== cwd) {
      throw new Error('Pi session cwd does not match the requested compatibility test cwd')
    }

    const executeCli = runCli ?? ((args: string[]) => runPiCli(piExecutable, cwd, args))
    const firstResponse = await executeCli(buildRestrictedCliArgs(sessionFile, CLI_TO_SDK_PROMPT))

    if (firstResponse !== CLI_TO_SDK_RESPONSE) {
      throw new Error('Pi CLI did not produce the expected CLI → SDK response')
    }

    const afterCliToSdk = snapshot(sessionFile)
    assertAdvanced(baseline, afterCliToSdk, 'CLI → SDK prompt')

    const sdk = await runSdk(
      sessionFile,
      cwd,
      CLI_TO_SDK_RESPONSE,
      SDK_TO_CLI_PROMPT,
      SDK_TO_CLI_RESPONSE,
    )

    if (sdk.messageCountAfter <= sdk.messageCountBefore || sdk.toolEventCount !== 0) {
      throw new Error('Pi SDK did not append the expected tool-free continuation')
    }

    const afterSdkToCli = snapshot(sessionFile)
    assertAdvanced(afterCliToSdk, afterSdkToCli, 'SDK → CLI prompt')

    const finalResponse = await executeCli(buildRestrictedCliArgs(sessionFile, CLI_SDK_VISIBLE_PROMPT))

    if (finalResponse !== CLI_SDK_VISIBLE_RESPONSE) {
      throw new Error('Pi CLI did not restore the SDK response as the current session context')
    }

    const afterVerificationCli = snapshot(sessionFile)
    assertAdvanced(afterSdkToCli, afterVerificationCli, 'CLI verification prompt')

    return {
      afterCliToSdk,
      afterSdkToCli,
      afterVerificationCli,
      baseline,
      sdk,
    }
  } catch (cause) {
    throw new Error(`Failed CLI → SDK → CLI spike for session: ${sessionFile}`, { cause })
  }
}
