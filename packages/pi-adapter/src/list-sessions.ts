import { SessionManager } from '@earendil-works/pi-coding-agent'

export type PiSessionSummary = {
  id: string
  name: string | undefined
  firstMessage: string | undefined
  sessionFile: string
  cwd: string | undefined
  updatedAt: string | undefined
}

const NO_MESSAGES = '(no messages)'
const FIRST_MESSAGE_LIMIT = 120

function sessionFirstMessage(raw: string | undefined) {
  const collapsed = raw?.replace(/\s+/g, ' ').trim()
  if (!collapsed || collapsed === NO_MESSAGES) return undefined

  const characters = Array.from(collapsed)
  return characters.length > FIRST_MESSAGE_LIMIT
    ? `${characters.slice(0, FIRST_MESSAGE_LIMIT).join('')}…`
    : collapsed
}

export async function listPiSessions(): Promise<PiSessionSummary[]> {
  try {
    const sessions = await SessionManager.listAll()

    return sessions.map((session) => ({
      id: session.id,
      name: session.name || undefined,
      firstMessage: sessionFirstMessage(session.firstMessage),
      sessionFile: session.path,
      cwd: session.cwd || undefined,
      updatedAt: session.modified.toISOString(),
    }))
  } catch (cause) {
    throw new Error('Failed to discover Pi sessions with SessionManager.listAll()', { cause })
  }
}
