import type { PiSessionBinding, PiSessionSummary } from '@pi-nest/pi-adapter'
import type { SessionIndex } from '../session-index.js'

/** Small mutable SessionIndex used by route tests; it never touches the filesystem. */
export function createSessionIndexFixture(initial: PiSessionSummary[] = []) {
  let sessions = initial.map((session) => ({ ...session }))
  const registerCalls: PiSessionBinding[] = []
  const invalidateCalls: string[] = []
  const forgetCalls: string[] = []

  function byId(sessionId: string) {
    return sessions.find((session) => session.id === sessionId)
  }

  function byIdOrFile(value: string) {
    return sessions.find((session) => session.id === value || session.sessionFile === value)
  }

  function bindingOf(session: PiSessionSummary): PiSessionBinding {
    return { id: session.id, cwd: session.cwd, sessionFile: session.sessionFile }
  }

  const index: SessionIndex = {
    async list() {
      return sessions.map((session) => ({ ...session }))
    },
    async resolve(sessionId) {
      const session = byId(sessionId)
      return session ? bindingOf(session) : undefined
    },
    async hasWorkspace(cwd) {
      return sessions.some((session) => session.cwd === cwd)
    },
    cachedSummary(sessionId) {
      const session = byId(sessionId)
      return session ? { ...session } : undefined
    },
    register(binding, summary) {
      registerCalls.push(binding)
      const next = summary
        ? { ...summary, ...binding }
        : {
            id: binding.id,
            cwd: binding.cwd,
            sessionFile: binding.sessionFile,
            name: undefined,
            firstMessage: undefined,
            createdAt: undefined,
            updatedAt: undefined,
          }
      const existing = sessions.findIndex((session) => session.sessionFile === binding.sessionFile)
      if (existing >= 0) sessions[existing] = next
      else sessions.push(next)
    },
    invalidate(value) {
      invalidateCalls.push(value)
    },
    forget(value) {
      forgetCalls.push(value)
      const session = byIdOrFile(value)
      if (session) sessions = sessions.filter((candidate) => candidate !== session)
    },
    close() {},
  }

  return {
    index,
    get sessions() {
      return sessions
    },
    setSessions(next: PiSessionSummary[]) {
      sessions = next.map((session) => ({ ...session }))
    },
    add(session: PiSessionSummary) {
      sessions.push({ ...session })
    },
    registerCalls,
    invalidateCalls,
    forgetCalls,
  }
}
