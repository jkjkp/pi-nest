import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

export type PiSessionRestoreSummary = {
  id: string
  sessionFile: string
  cwd: string | undefined
  restoredMessageCount: number
  model: { provider: string; id: string } | undefined
  thinkingLevel: string
  modelRestoreWarning: string | undefined
}

export async function restorePiSession(sessionFile: string): Promise<PiSessionRestoreSummary> {
  try {
    const nativeSession = SessionManager.open(sessionFile)
    const header = nativeSession.getHeader()
    const openedSessionFile = nativeSession.getSessionFile()

    if (!header || !openedSessionFile) {
      throw new Error('Pi SDK did not return session metadata after opening it')
    }

    const cwd = header.cwd || undefined
    const settingsManager = SettingsManager.create(cwd ?? nativeSession.getCwd(), getAgentDir())
    const resourceLoader = new DefaultResourceLoader({
      cwd: cwd ?? nativeSession.getCwd(),
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    await resourceLoader.reload()

    const sessionManager = SessionManager.inMemory(
      cwd ?? nativeSession.getCwd(),
      undefined,
      [header, ...nativeSession.getEntries()],
    )
    const { session, modelFallbackMessage } = await createAgentSession({
      sessionManager,
      settingsManager,
      resourceLoader,
      noTools: 'all',
    })

    try {
      return {
        id: nativeSession.getSessionId(),
        sessionFile: openedSessionFile,
        cwd,
        restoredMessageCount: session.messages.length,
        model: session.model && { provider: session.model.provider, id: session.model.id },
        thinkingLevel: session.thinkingLevel,
        modelRestoreWarning: modelFallbackMessage,
      }
    } finally {
      session.dispose()
    }
  } catch (cause) {
    throw new Error(`Failed to restore Pi session: ${sessionFile}`, { cause })
  }
}
