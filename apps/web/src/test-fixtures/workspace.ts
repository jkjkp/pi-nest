import type { QueryClient } from '@tanstack/react-query'
import type { PiProject, PiSessionSummary } from '@pi-nest/contracts'
import { groupSessionsByProject } from '../workspace.js'

export function fixtureProject(cwd: string, createdAt = '1970-01-01T00:00:00.000Z'): PiProject {
  return { id: cwd, cwd, createdAt, removedAt: null }
}
export function fixtureProjects(sessions: PiSessionSummary[]) {
  const times = new Map<string, string>()
  for (const session of sessions) {
    if (!session.cwd) continue
    const time = session.createdAt && Number.isFinite(Date.parse(session.createdAt)) ? session.createdAt : '1970-01-01T00:00:00.000Z'
    const saved = times.get(session.cwd)
    if (!saved || time < saved) times.set(session.cwd, time)
  }
  return [...times].map(([cwd, time]) => fixtureProject(cwd, time))
}
export function seedWorkspaceProjects(client: QueryClient) {
  const sessions = client.getQueryData<PiSessionSummary[]>(['sessions']) ?? []
  const projects = client.getQueryData<PiProject[]>(['projects'])
  if (!projects?.length) client.setQueryData(['projects'], fixtureProjects(sessions))
  client.setQueryData(['sessions'], sessions.map((session) => ({ ...session, projectId: session.cwd })))
}
export function groupFixtureSessions(sessions: PiSessionSummary[], times: Record<string, string> = {}, projects = fixtureProjects(sessions)) {
  return groupSessionsByProject(sessions.map((session) => ({ ...session, projectId: session.cwd })), times, projects)
}
