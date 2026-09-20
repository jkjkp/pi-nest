import { SessionManager } from '@earendil-works/pi-coding-agent'

import { createRestrictedAgentSession } from './create-restricted-agent-session.js'

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
    const sessionManager = SessionManager.inMemory(
      cwd ?? nativeSession.getCwd(),
      undefined,
      [header, ...nativeSession.getEntries()],
    )
    const { session, modelFallbackMessage } = await createRestrictedAgentSession(
      sessionManager,
      cwd ?? nativeSession.getCwd(),
    )

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

export async function restorePersistentPiSession(sessionFile: string): Promise<PiSessionRestoreSummary> {
  try {
    const sessionManager = SessionManager.open(sessionFile)
    const header = sessionManager.getHeader()
    const openedSessionFile = sessionManager.getSessionFile()

    if (!header || !openedSessionFile) {
      throw new Error('Pi SDK did not return session metadata after opening it')
    }

    const cwd = header.cwd || sessionManager.getCwd()
    const { session, modelFallbackMessage } = await createRestrictedAgentSession(sessionManager, cwd)

    try {
      if (session.sessionId !== sessionManager.getSessionId() || session.sessionFile !== openedSessionFile) {
        throw new Error('Pi SDK did not keep the AgentSession bound to the requested native session')
      }

      return {
        id: session.sessionId,
        sessionFile: session.sessionFile,
        cwd: header.cwd || undefined,
        restoredMessageCount: session.messages.length,
        model: session.model && { provider: session.model.provider, id: session.model.id },
        thinkingLevel: session.thinkingLevel,
        modelRestoreWarning: modelFallbackMessage,
      }
    } finally {
      session.dispose()
    }
  } catch (cause) {
    throw new Error(`Failed to restore persistent Pi session: ${sessionFile}`, { cause })
  }
}
