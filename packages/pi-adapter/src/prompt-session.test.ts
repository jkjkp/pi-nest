import { beforeEach, describe, expect, it, vi } from 'vitest'

const open = vi.fn()
const createRestrictedAgentSession = vi.fn()

vi.mock('@earendil-works/pi-coding-agent', () => ({
  SessionManager: { open },
}))

vi.mock('./create-restricted-agent-session.js', () => ({ createRestrictedAgentSession }))

function createSession() {
  let listener: ((event: any) => void) | undefined
  const unsubscribe = vi.fn()
  const session = {
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    messages: [{ role: 'assistant', stopReason: 'stop' }] as Array<{
      role: string
      stopReason?: string
    }>,
    model: { provider: 'provider', id: 'model' },
    prompt: vi.fn(async () => {
      listener?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'OK' },
      })
      session.messages.push({ role: 'user' }, { role: 'assistant', stopReason: 'stop' })
    }),
    sessionFile: '/pi/session.jsonl',
    sessionId: 'session-1',
    subscribe: vi.fn((nextListener) => {
      listener = nextListener
      return unsubscribe
    }),
  }

  return { session, unsubscribe, emit: (event: any) => listener?.(event) }
}

describe('promptPiSession', () => {
  beforeEach(() => {
    open.mockReset()
    createRestrictedAgentSession.mockReset()
  })

  it('continues the requested native session and streams text deltas', async () => {
    const { session, unsubscribe } = createSession()
    const sessionManager = {
      getHeader: vi.fn().mockReturnValue({ cwd: '/working' }),
      getSessionFile: vi.fn().mockReturnValue('/pi/session.jsonl'),
      getSessionId: vi.fn().mockReturnValue('session-1'),
    }
    open.mockReturnValue(sessionManager)
    createRestrictedAgentSession.mockResolvedValue({ session })
    const { promptPiSession } = await import('./prompt-session.js')
    const onTextDelta = vi.fn()

    await expect(
      promptPiSession({
        expectedCwd: '/working',
        expectedSessionId: 'session-1',
        onTextDelta,
        prompt: 'prompt',
        sessionFile: '/pi/session.jsonl',
      }),
    ).resolves.toEqual({
      cwd: '/working',
      id: 'session-1',
      messageCountAfter: 3,
      messageCountBefore: 1,
      model: { provider: 'provider', id: 'model' },
      stopReason: 'stop',
      textDeltaCount: 1,
      toolEventCount: 0,
    })
    expect(createRestrictedAgentSession).toHaveBeenCalledWith(sessionManager, '/working')
    expect(session.prompt).toHaveBeenCalledWith('prompt', { expandPromptTemplates: false })
    expect(onTextDelta).toHaveBeenCalledWith('OK')
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(session.dispose).toHaveBeenCalledOnce()
  })

  it('rejects a native session whose identity does not match the request', async () => {
    open.mockReturnValue({
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/session.jsonl',
      getSessionId: () => 'different-session',
    })
    const { promptPiSession } = await import('./prompt-session.js')

    await expect(
      promptPiSession({
        expectedCwd: '/working',
        expectedSessionId: 'session-1',
        prompt: 'prompt',
        sessionFile: '/pi/session.jsonl',
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'Pi SDK did not open the requested native session' }),
    })
    expect(createRestrictedAgentSession).not.toHaveBeenCalled()
  })

  it('aborts once and cleans up when its signal is cancelled', async () => {
    const { session, unsubscribe } = createSession()
    const controller = new AbortController()
    session.prompt.mockImplementation(async () => {
      controller.abort()
      controller.abort()
      session.messages.push({ role: 'user' }, { role: 'assistant', stopReason: 'aborted' })
    })
    open.mockReturnValue({
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/session.jsonl',
      getSessionId: () => 'session-1',
    })
    createRestrictedAgentSession.mockResolvedValue({ session })
    const { promptPiSession } = await import('./prompt-session.js')

    await expect(
      promptPiSession({
        expectedCwd: '/working',
        expectedSessionId: 'session-1',
        prompt: 'prompt',
        sessionFile: '/pi/session.jsonl',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ stopReason: 'aborted' })
    expect(session.abort).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(session.dispose).toHaveBeenCalledOnce()
  })

  it('rejects tool events and preserves cleanup', async () => {
    const { session, unsubscribe, emit } = createSession()
    session.prompt.mockImplementation(async () => {
      emit({ type: 'tool_execution_start' })
      session.messages.push({ role: 'user' }, { role: 'assistant', stopReason: 'stop' })
    })
    open.mockReturnValue({
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/session.jsonl',
      getSessionId: () => 'session-1',
    })
    createRestrictedAgentSession.mockResolvedValue({ session })
    const { promptPiSession } = await import('./prompt-session.js')

    await expect(
      promptPiSession({
        expectedCwd: '/working',
        expectedSessionId: 'session-1',
        prompt: 'prompt',
        sessionFile: '/pi/session.jsonl',
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'Pi SDK emitted tool events despite tools being disabled' }),
    })
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(session.dispose).toHaveBeenCalledOnce()
  })

  it('preserves abort failures as the cause', async () => {
    const cause = new Error('abort failed')
    const { session, unsubscribe } = createSession()
    const controller = new AbortController()
    session.abort.mockRejectedValue(cause)
    session.prompt.mockImplementation(async () => {
      controller.abort()
      session.messages.push({ role: 'user' }, { role: 'assistant', stopReason: 'aborted' })
    })
    open.mockReturnValue({
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/session.jsonl',
      getSessionId: () => 'session-1',
    })
    createRestrictedAgentSession.mockResolvedValue({ session })
    const { promptPiSession } = await import('./prompt-session.js')

    await expect(
      promptPiSession({
        expectedCwd: '/working',
        expectedSessionId: 'session-1',
        prompt: 'prompt',
        sessionFile: '/pi/session.jsonl',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ message: 'Failed to prompt Pi session: /pi/session.jsonl', cause })
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(session.dispose).toHaveBeenCalledOnce()
  })

  it('preserves prompt failures as the cause and exports the public capability', async () => {
    const cause = new Error('prompt failed')
    const { session, unsubscribe } = createSession()
    session.prompt.mockRejectedValue(cause)
    open.mockReturnValue({
      getHeader: () => ({ cwd: '/working' }),
      getSessionFile: () => '/pi/session.jsonl',
      getSessionId: () => 'session-1',
    })
    createRestrictedAgentSession.mockResolvedValue({ session })
    const { promptPiSession } = await import('./prompt-session.js')

    await expect(
      promptPiSession({
        expectedCwd: '/working',
        expectedSessionId: 'session-1',
        prompt: 'prompt',
        sessionFile: '/pi/session.jsonl',
      }),
    ).rejects.toMatchObject({ message: 'Failed to prompt Pi session: /pi/session.jsonl', cause })
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(session.dispose).toHaveBeenCalledOnce()

    const entry = await import('./index.js')
    expect(entry.promptPiSession).toBe(promptPiSession)
  })
})
