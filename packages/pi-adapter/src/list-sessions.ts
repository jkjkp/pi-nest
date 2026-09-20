import { SessionManager } from '@earendil-works/pi-coding-agent'

export type PiSessionSummary = {
  id: string
  sessionFile: string
  cwd: string | undefined
  updatedAt: string | undefined
}

export async function listPiSessions(): Promise<PiSessionSummary[]> {
  try {
    const sessions = await SessionManager.listAll()

    return sessions.map((session) => ({
      id: session.id,
      sessionFile: session.path,
      cwd: session.cwd || undefined,
      updatedAt: session.modified.toISOString(),
    }))
  } catch (cause) {
    throw new Error('Failed to discover Pi sessions with SessionManager.listAll()', { cause })
  }
}
