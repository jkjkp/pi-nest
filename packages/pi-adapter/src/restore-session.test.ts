import { beforeEach, describe, expect, it, vi } from 'vitest'

const createAgentSession = vi.fn()
const getAgentDir = vi.fn()
const inMemory = vi.fn()
const open = vi.fn()
const reload = vi.fn()
const SettingsManagerCreate = vi.fn()
const DefaultResourceLoader = vi.fn()

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager: { inMemory, open },
  SettingsManager: { create: SettingsManagerCreate },
}))

describe('restorePiSession', () => {
  beforeEach(() => {
    createAgentSession.mockReset()
    getAgentDir.mockReset()
    inMemory.mockReset()
    open.mockReset()
    reload.mockReset()
    SettingsManagerCreate.mockReset()
    DefaultResourceLoader.mockReset()
  })

  it('is exported from the package entry point', async () => {
    const entry = await import('./index.js')

    expect(entry.restorePiSession).toBeTypeOf('function')
    expect(entry.restorePersistentPiSession).toBeTypeOf('function')
  })

  it('restores into an in-memory session with resources and tools disabled', async () => {
    const header = { id: 'session-1', cwd: '/project' }
    const entries = [{ type: 'message', message: { content: 'not returned' } }]
    const nativeSession = {
      getCwd: () => '/project',
      getEntries: () => entries,
      getHeader: () => header,
      getSessionFile: () => '/pi/sessions/session-1.jsonl',
      getSessionId: () => 'session-1',
    }
    const settingsManager = {}
    const resourceLoader = { reload }
    const sessionManager = {}
    const dispose = vi.fn()

    open.mockReturnValue(nativeSession)
    getAgentDir.mockReturnValue('/pi/agent')
    SettingsManagerCreate.mockReturnValue(settingsManager)
    DefaultResourceLoader.mockImplementation(function () {
      return resourceLoader
    })
    inMemory.mockReturnValue(sessionManager)
    createAgentSession.mockResolvedValue({
      modelFallbackMessage: 'Could not restore model provider/model',
      session: {
        dispose,
        messages: [{ role: 'user' }],
        model: { provider: 'fallback', id: 'model-2' },
        thinkingLevel: 'medium',
      },
    })
    const { restorePiSession } = await import('./index.js')

    await expect(restorePiSession('/pi/sessions/session-1.jsonl')).resolves.toEqual({
      id: 'session-1',
      sessionFile: '/pi/sessions/session-1.jsonl',
      cwd: '/project',
      restoredMessageCount: 1,
      model: { provider: 'fallback', id: 'model-2' },
      thinkingLevel: 'medium',
      modelRestoreWarning: 'Could not restore model provider/model',
    })
    expect(inMemory).toHaveBeenCalledWith('/project', undefined, [header, ...entries])
    expect(DefaultResourceLoader).toHaveBeenCalledWith({
      cwd: '/project',
      agentDir: '/pi/agent',
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    expect(reload).toHaveBeenCalledOnce()
    expect(createAgentSession).toHaveBeenCalledWith({
      sessionManager,
      settingsManager,
      resourceLoader,
      noTools: 'all',
    })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('adds context while preserving an SDK failure as the cause', async () => {
    const cause = new Error('Pi session is unavailable')
    open.mockImplementation(() => {
      throw cause
    })
    const { restorePiSession } = await import('./index.js')

    await expect(restorePiSession('/pi/sessions/session-1.jsonl')).rejects.toMatchObject({
      message: 'Failed to restore Pi session: /pi/sessions/session-1.jsonl',
      cause,
    })
  })

  it('keeps the restored AgentSession bound to the native session', async () => {
    const header = { id: 'session-1', cwd: '/project' }
    const nativeSession = {
      getCwd: () => '/project',
      getHeader: () => header,
      getSessionFile: () => '/pi/sessions/session-1.jsonl',
      getSessionId: () => 'session-1',
    }
    const settingsManager = {}
    const resourceLoader = { reload }
    const dispose = vi.fn()

    open.mockReturnValue(nativeSession)
    getAgentDir.mockReturnValue('/pi/agent')
    SettingsManagerCreate.mockReturnValue(settingsManager)
    DefaultResourceLoader.mockImplementation(function () {
      return resourceLoader
    })
    createAgentSession.mockResolvedValue({
      session: {
        dispose,
        messages: [{ role: 'user' }],
        model: { provider: 'provider', id: 'model' },
        sessionFile: '/pi/sessions/session-1.jsonl',
        sessionId: 'session-1',
        thinkingLevel: 'high',
      },
    })
    const { restorePersistentPiSession } = await import('./index.js')

    await expect(restorePersistentPiSession('/pi/sessions/session-1.jsonl')).resolves.toMatchObject({
      id: 'session-1',
      sessionFile: '/pi/sessions/session-1.jsonl',
      restoredMessageCount: 1,
    })
    expect(inMemory).not.toHaveBeenCalled()
    expect(createAgentSession).toHaveBeenCalledWith({
      sessionManager: nativeSession,
      settingsManager,
      resourceLoader,
      noTools: 'all',
    })
    expect(dispose).toHaveBeenCalledOnce()
  })
})
