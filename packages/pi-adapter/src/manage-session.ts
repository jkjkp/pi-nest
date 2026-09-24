import { execFile, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

import { SessionManager } from '@earendil-works/pi-coding-agent'

export type PiSessionMutationOptions = {
  expectedCwd?: string
  expectedSessionId: string
  sessionFile: string
}

export type PiDeletedSession = {
  method: 'trash' | 'unlink'
}

export type PiCreatedSession = {
  cwd: string
  id: string
  sessionFile: string
}

const executeFile = promisify(execFile)

function validatedCwd(cwd: string) {
  const value = cwd.trim()
  if (!isAbsolute(value)) throw new Error('Pi workspace path must be absolute')
  return resolve(value)
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

/** Creates a native Pi session bound to the supplied project directory. */
export function createPiSession(cwd: string): PiCreatedSession {
  const expectedCwd = validatedCwd(cwd)
  try {
    const session = SessionManager.create(expectedCwd)
    const header = session.getHeader()
    const id = session.getSessionId()
    const sessionFile = session.getSessionFile()
    if (!id || !sessionFile || header?.cwd !== expectedCwd) throw new Error('Pi session creation binding did not match the requested workspace')

    // The Pi SDK defers its first write until an assistant response. Seed its own
    // header so the RPC process opens this exact native session instead of creating another ID.
    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: 'wx', mode: 0o600 })
    return { cwd: expectedCwd, id, sessionFile }
  } catch (cause) {
    throw new Error(`Failed to create Pi session for ${expectedCwd}`, { cause })
  }
}

/** Reveals a known local workspace in macOS Finder without modifying it. */
export async function revealPiWorkspace(cwd: string) {
  const workspace = validatedCwd(cwd)
  try {
    await executeFile('/usr/bin/open', ['-R', workspace])
  } catch (cause) {
    throw new Error(`Failed to reveal Pi workspace ${workspace}`, { cause })
  }
}
