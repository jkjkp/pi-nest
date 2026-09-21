import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

import { SessionManager } from '@earendil-works/pi-coding-agent'

export type PiSessionMutationOptions = {
  expectedCwd?: string
  expectedSessionId: string
  sessionFile: string
}

export type PiDeletedSession = {
  method: 'trash' | 'unlink'
}

function openBoundSession({ expectedCwd, expectedSessionId, sessionFile }: PiSessionMutationOptions) {
  const session = SessionManager.open(sessionFile)
  const header = session.getHeader()

  if (
    !header ||
    session.getSessionId() !== expectedSessionId ||
    session.getSessionFile() !== sessionFile ||
    (header.cwd || undefined) !== expectedCwd
  ) {
    throw new Error('Pi session binding did not match the requested session')
  }

  return session
}

function validatedName(name: string) {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 120) {
    throw new Error('Pi session name must contain 1 to 120 characters')
  }
  return trimmed
}

export function renamePiSession(options: PiSessionMutationOptions & { name: string }): void {
  try {
    openBoundSession(options).appendSessionInfo(validatedName(options.name))
  } catch (cause) {
    throw new Error(`Failed to rename Pi session ${options.expectedSessionId}`, { cause })
  }
}

export async function deletePiSession(options: PiSessionMutationOptions): Promise<PiDeletedSession> {
  try {
    openBoundSession(options)

    const trashArgs = options.sessionFile.startsWith('-') ? ['--', options.sessionFile] : [options.sessionFile]
    const trashed = spawnSync('/usr/bin/trash', trashArgs, { encoding: 'utf8' })
    if (trashed.status === 0 || !existsSync(options.sessionFile)) return { method: 'trash' }

    await unlink(options.sessionFile)
    return { method: 'unlink' }
  } catch (cause) {
    throw new Error(`Failed to delete Pi session ${options.expectedSessionId}`, { cause })
  }
}
