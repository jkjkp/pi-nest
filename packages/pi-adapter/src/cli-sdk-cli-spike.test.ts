import { beforeEach, describe, expect, it, vi } from 'vitest'

const createAgentSession = vi.fn()
const getAgentDir = vi.fn()
const open = vi.fn()
const reload = vi.fn()
const SettingsManagerCreate = vi.fn()
const DefaultResourceLoader = vi.fn()

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager: { open },
  SettingsManager: { create: SettingsManagerCreate },
}))

describe('CLI → SDK → CLI spike', () => {
  beforeEach(() => {
    createAgentSession.mockReset()
    getAgentDir.mockReset()
    open.mockReset()
    reload.mockReset()
    SettingsManagerCreate.mockReset()
    DefaultResourceLoader.mockReset()
  })

  it('builds a session-bound CLI command with resources and tools disabled', async () => {
    const { buildRestrictedCliArgs } = await import('./cli-sdk-cli-spike.js')

    expect(buildRestrictedCliArgs('/pi/sessions/session-1.jsonl', 'marker')).toEqual([
      '--session',
      '/pi/sessions/session-1.jsonl',
      '--print',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      'marker',
    ])
  })

  it('closes CLI stdin before waiting for the process result', async () => {
    const end = vi.fn()
    let resolveExecution: ((result: { stdout: string; stderr: string }) => void) | undefined
    const execution = Object.assign(
      new Promise<{ stdout: string; stderr: string }>((resolve) => {
        resolveExecution = resolve
      }),
      { child: { stdin: { end } } },
    )
    const execute = vi.fn().mockReturnValue(execution)
    const { runPiCli } = await import('./cli-sdk-cli-spike.js')
    const result = runPiCli('/pi/bin/pi', '/working', ['--print'], execute as never)

    expect(end).toHaveBeenCalledOnce()
    resolveExecution?.({ stdout: 'CLI_TO_SDK_OK\n', stderr: '' })
    await expect(result).resolves.toBe('CLI_TO_SDK_OK')
  })

  it('closes CLI stdin when the process rejects', async () => {
    const cause = new Error('Pi CLI failed')
    const end = vi.fn()
    const execution = Object.assign(Promise.reject(cause), { child: { stdin: { end } } })
    const execute = vi.fn().mockReturnValue(execution)
    const { runPiCli } = await import('./cli-sdk-cli-spike.js')

    await expect(runPiCli('/pi/bin/pi', '/working', ['--print'], execute as never)).rejects.toBe(cause)
    expect(end).toHaveBeenCalledOnce()
  })

  it('restores the CLI response, appends a tool-free SDK response, and cleans up', async () => {
    const dispose = vi.fn()
    const unsubscribe = vi.fn()
    const session = {
      dispose,
      getLastAssistantText: vi
        .fn()
        .mockReturnValueOnce('CLI_TO_SDK_OK')
        .mockReturnValueOnce('SDK_TO_CLI_OK'),
      messages: [{ role: 'user' }, { role: 'assistant' }] as Array<{ role: string }>,
      model: { id: 'model', provider: 'provider' },
      prompt: vi.fn(async () => {
        session.messages.push({ role: 'user' }, { role: 'assistant' })
      }),
      sessionFile: '/pi/sessions/session-1.jsonl',
      sessionId: 'session-1',
      subscribe: vi.fn().mockReturnValue(unsubscribe),
    }
    const sessionManager = {
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/sessions/session-1.jsonl',
      getSessionId: () => 'session-1',
    }
    const settingsManager = {}
    const resourceLoader = { reload }

    open.mockReturnValue(sessionManager)
    getAgentDir.mockReturnValue('/pi/agent')
    SettingsManagerCreate.mockReturnValue(settingsManager)
    DefaultResourceLoader.mockImplementation(function () {
      return resourceLoader
    })
    createAgentSession.mockResolvedValue({ session })
    const { runPiSdkContinuation } = await import('./cli-sdk-cli-spike.js')

    await expect(
      runPiSdkContinuation(
        '/pi/sessions/session-1.jsonl',
        '/working',
        'CLI_TO_SDK_OK',
        'Reply with exactly SDK_TO_CLI_OK and no other text.',
        'SDK_TO_CLI_OK',
      ),
    ).resolves.toMatchObject({
      messageCountBefore: 2,
      messageCountAfter: 4,
      model: { id: 'model', provider: 'provider' },
      toolEventCount: 0,
    })
    expect(DefaultResourceLoader).toHaveBeenCalledWith({
      cwd: '/working',
      agentDir: '/pi/agent',
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    expect(createAgentSession).toHaveBeenCalledWith({
      sessionManager,
      settingsManager,
      resourceLoader,
      noTools: 'all',
    })
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('runs all three phases in order and retains only safe summaries', async () => {
    const snapshots = [
      { cwd: '/working', hash: 'a', id: 'session-1', leafId: 'a', messageCount: 5, size: 100 },
      { cwd: '/working', hash: 'b', id: 'session-1', leafId: 'b', messageCount: 7, size: 200 },
      { cwd: '/working', hash: 'c', id: 'session-1', leafId: 'c', messageCount: 9, size: 300 },
      { cwd: '/working', hash: 'd', id: 'session-1', leafId: 'd', messageCount: 11, size: 400 },
    ]
    const runCli = vi.fn().mockResolvedValueOnce('CLI_TO_SDK_OK').mockResolvedValueOnce('CLI_SDK_VISIBLE')
    const runSdk = vi.fn().mockResolvedValue({
      messageCountAfter: 9,
      messageCountBefore: 7,
      model: { id: 'model', provider: 'provider' },
      modelRestoreWarning: undefined,
      toolEventCount: 0,
    })
    const { runPiCliSdkCliSpike } = await import('./cli-sdk-cli-spike.js')

    await expect(
      runPiCliSdkCliSpike({
        cwd: '/working',
        piExecutable: '/pi/bin/pi',
        runCli,
        runSdk,
        sessionFile: '/pi/sessions/session-1.jsonl',
        snapshot: vi.fn(() => snapshots.shift()!),
      }),
    ).resolves.toMatchObject({
      baseline: { hash: 'a' },
      afterVerificationCli: { hash: 'd' },
      sdk: { toolEventCount: 0 },
    })
    expect(runCli).toHaveBeenCalledTimes(2)
    expect(runSdk).toHaveBeenCalledWith(
      '/pi/sessions/session-1.jsonl',
      '/working',
      'CLI_TO_SDK_OK',
      'Reply with exactly SDK_TO_CLI_OK and no other text.',
      'SDK_TO_CLI_OK',
    )
  })

  it('preserves a CLI failure as the cause', async () => {
    const cause = new Error('Pi CLI failed')
    const { runPiCliSdkCliSpike } = await import('./cli-sdk-cli-spike.js')

    await expect(
      runPiCliSdkCliSpike({
        cwd: '/working',
        piExecutable: '/pi/bin/pi',
        runCli: vi.fn().mockRejectedValue(cause),
        sessionFile: '/pi/sessions/session-1.jsonl',
        snapshot: () => ({ cwd: '/working', hash: 'a', id: 'session-1', leafId: 'a', messageCount: 5, size: 100 }),
      }),
    ).rejects.toMatchObject({
      message: 'Failed CLI → SDK → CLI spike for session: /pi/sessions/session-1.jsonl',
      cause,
    })
  })
})
