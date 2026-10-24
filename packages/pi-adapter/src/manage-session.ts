import { execFile, spawn, spawnSync } from 'node:child_process'
import { constants, existsSync, writeFileSync } from 'node:fs'
import { access, stat, unlink } from 'node:fs/promises'
import { isAbsolute, resolve, win32 } from 'node:path'
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
  createdAt: string
  cwd: string
  id: string
  sessionFile: string
}

const executeFile = promisify(execFile)

function validatedCwd(cwd: string) {
  const value = cwd.trim()
  const paths = process.platform === 'win32' ? win32 : { isAbsolute, resolve }
  if (!paths.isAbsolute(value)) throw new Error('Pi workspace path must be absolute')
  return paths.resolve(value)
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

    // The Pi SDK defers its first write until a user or assistant message. Seed its own
    // header so the RPC process opens this exact native session instead of creating another ID.
    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: 'wx', mode: 0o600 })
    return { createdAt: header.timestamp, cwd: expectedCwd, id, sessionFile }
  } catch (cause) {
    throw new Error(`Failed to create Pi session for ${expectedCwd}`, { cause })
  }
}

/** Opens a known local workspace in the server's system file manager. */
export async function revealPiWorkspace(cwd: string) {
  const workspace = validatedCwd(cwd)
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) {
    throw Object.assign(new Error('Unsupported system file manager'), { code: 'PROJECT_FOLDER_UNSUPPORTED' })
  }
  try {
    if (!(await stat(workspace)).isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' })
    await access(workspace, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK))
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    throw Object.assign(new Error(`Cannot access Pi workspace ${workspace}`, { cause }), {
      code: code === 'EACCES' || code === 'EPERM' ? 'PROJECT_FOLDER_ACCESS_DENIED' : 'PROJECT_FOLDER_UNAVAILABLE',
    })
  }
  try {
    if (process.platform === 'win32') {
      // Explorer hands off to an existing process; its exit code does not confirm whether the folder opened.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'explorer.exe'), [workspace], {
          shell: false, windowsHide: true, detached: true, stdio: 'ignore',
        })
        child.once('error', reject)
        child.once('spawn', () => { child.unref(); resolve() })
      })
    } else {
      await executeFile(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [workspace], { timeout: 10_000, shell: false })
    }
  } catch (cause) {
    throw Object.assign(new Error(`Failed to open Pi workspace ${workspace}`, { cause }), { code: 'PROJECT_FOLDER_OPEN_FAILED' })
  }
}
