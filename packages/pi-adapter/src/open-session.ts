import { SessionManager } from '@earendil-works/pi-coding-agent'

export type PiOpenedSessionSummary = {
  id: string
  sessionFile: string
  cwd: string | undefined
  messageCount: number
  leafId: string | undefined
}

export function openPiSession(sessionFile: string): PiOpenedSessionSummary {
  try {
    const session = SessionManager.open(sessionFile)
    const openedSessionFile = session.getSessionFile()

    if (!openedSessionFile) {
      throw new Error('Pi SDK did not return a session file after opening it')
    }

    return {
      id: session.getSessionId(),
      sessionFile: openedSessionFile,
      cwd: session.getHeader()?.cwd || undefined,
      messageCount: session.getEntries().filter((entry) => entry.type === 'message').length,
      leafId: session.getLeafId() || undefined,
    }
  } catch (cause) {
    throw new Error(`Failed to open Pi session: ${sessionFile}`, { cause })
  }
}
