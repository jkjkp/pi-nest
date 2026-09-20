import { beforeEach, describe, expect, it, vi } from 'vitest'

const createAgentSession = vi.fn()
const create = vi.fn()
const getAgentDir = vi.fn()
const reload = vi.fn()
const SettingsManagerCreate = vi.fn()
const DefaultResourceLoader = vi.fn()

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager: { create },
  SettingsManager: { create: SettingsManagerCreate },
}))

describe('runPiConversationSpike', () => {
  beforeEach(() => {
    createAgentSession.mockReset()
    create.mockReset()
    getAgentDir.mockReset()
    reload.mockReset()
    SettingsManagerCreate.mockReset()
    DefaultResourceLoader.mockReset()
  })

  it('creates a restricted native session, streams a completed response, and aborts the next response', async () => {
    let listener: ((event: any) => void) | undefined
    const abort = vi.fn().mockResolvedValue(undefined)
    const dispose = vi.fn()
    const unsubscribe = vi.fn()
    const session = {
      abort,
      dispose,
      getLastAssistantText: vi.fn().mockReturnValue('PI_NEST_STREAM_COMPLETE'),
      messages: [] as Array<{ role: string; stopReason?: string }>,
      model: { provider: 'provider', id: 'model' },
      prompt: vi.fn(async (prompt: string) => {
        if (prompt.startsWith('Reply with exactly')) {
          listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'PI_NEST_' } })
          listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'STREAM_COMPLETE' } })
          session.messages = [{ role: 'assistant', stopReason: 'stop' }]
          listener?.({ type: 'agent_end' })
          return
        }

        listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '1. ' } })
        session.messages = [{ role: 'assistant', stopReason: 'aborted' }]
        listener?.({ type: 'agent_end' })
      }),
      sessionFile: '/pi/sessions/session-1.jsonl',
      sessionId: 'session-1',
      subscribe: vi.fn((nextListener) => {
        listener = nextListener
        return unsubscribe
      }),
    }
    const settingsManager = {}
    const resourceLoader = { reload }
    const sessionManager = {}

    create.mockReturnValue(sessionManager)
    getAgentDir.mockReturnValue('/pi/agent')
    SettingsManagerCreate.mockReturnValue(settingsManager)
    DefaultResourceLoader.mockImplementation(function () {
      return resourceLoader
    })
    createAgentSession.mockResolvedValue({ session })
    const { runPiConversationSpike } = await import('./conversation-spike.js')
    const onTextDelta = vi.fn()

    await expect(runPiConversationSpike('/working', onTextDelta)).resolves.toEqual({
      aborted: {
        agentEndCount: 1,
        abortRequested: true,
        assistantStopReason: 'aborted',
        textDeltaCount: 1,
      },
      completed: {
        agentEndCount: 1,
        assistantStopReason: 'stop',
        textDeltaCount: 2,
      },
      cwd: '/working',
      id: 'session-1',
      model: { provider: 'provider', id: 'model' },
      modelRestoreWarning: undefined,
      sessionFile: '/pi/sessions/session-1.jsonl',
      toolEventCount: 0,
    })
    expect(create).toHaveBeenCalledWith('/working')
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
    expect(onTextDelta).toHaveBeenNthCalledWith(1, { phase: 'complete', delta: 'PI_NEST_' })
    expect(onTextDelta).toHaveBeenNthCalledWith(3, { phase: 'abort', delta: '1. ' })
    expect(abort).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('adds context to SDK failures and cleans up the native session', async () => {
    const cause = new Error('prompt failed')
    const unsubscribe = vi.fn()
    const dispose = vi.fn()
    const session = {
      dispose,
      prompt: vi.fn().mockRejectedValue(cause),
      subscribe: vi.fn().mockReturnValue(unsubscribe),
    }

    create.mockReturnValue({})
    getAgentDir.mockReturnValue('/pi/agent')
    SettingsManagerCreate.mockReturnValue({})
    DefaultResourceLoader.mockImplementation(function () {
      return { reload }
    })
    createAgentSession.mockResolvedValue({ session })
    const { runPiConversationSpike } = await import('./conversation-spike.js')

    await expect(runPiConversationSpike('/working')).rejects.toMatchObject({
      message: 'Failed to run Pi conversation spike in cwd: /working',
      cause,
    })
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not expose the spike implementation from the package entry point', async () => {
    const entry = await import('./index.js')

    expect('runPiConversationSpike' in entry).toBe(false)
  })
})
