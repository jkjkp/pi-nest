import type { PiRuntimeSettings, PiSettingsSnapshot, PiSessionsResponse } from '@pi-nest/contracts'
import { historyPageSize, type PiSessionHistoryResponse, type PiSessionTurnIndex } from './history.js'
import type { PiSessionSummary } from './workspace.js'

export type { PiRuntimeSettings, PiSettingsSnapshot } from '@pi-nest/contracts'

export class RequestError extends Error {
  status: number
  code?: string
  constructor(status: number, code?: string) {
    super(`Request failed with status ${status}`)
    this.status = status
    this.code = code
  }
}

async function fetchJson<T>(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    signal?.throwIfAborted()
    throw new RequestError(response.status, typeof body?.code === 'string' ? body.code : undefined)
  }
  return (await response.json()) as T
}

function sessionUrl(sessionId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}`
}

export function fetchSessionHistory(sessionId: string, before?: string, revision?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: String(historyPageSize) })
  if (before) query.set('before', before)
  if (revision) query.set('revision', revision)
  return fetchJson<PiSessionHistoryResponse>(`${sessionUrl(sessionId)}/history?${query}`, signal)
}

export function fetchSessionTurnIndex(sessionId: string, revision: string, signal?: AbortSignal) {
  return fetchJson<PiSessionTurnIndex>(`${sessionUrl(sessionId)}/turn-index?${new URLSearchParams({ revision })}`, signal)
}

export async function fetchSessions() {
  const body = await fetchJson<Partial<PiSessionsResponse>>('/api/sessions')
  if (!Array.isArray(body.sessions)) throw new Error('Invalid session list response')
  return body.sessions
}

export async function createSession(cwd: string, prompt: string) {
  const response = await fetch('/api/sessions', {
    body: JSON.stringify({ cwd, prompt }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error('Failed to create Pi session')
  const body = await response.json() as { session?: PiSessionSummary }
  if (!body.session?.id || !body.session.cwd) throw new Error('Invalid Pi session creation response')
  return body.session
}

export async function revealProjectInFinder(cwd: string) {
  const response = await fetch('/api/projects/reveal', {
    body: JSON.stringify({ cwd }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error('Failed to reveal Pi workspace in Finder')
}

export async function deleteSession(sessionId: string) {
  const response = await fetch(sessionUrl(sessionId), { method: 'DELETE' })
  if (!response.ok) throw new Error('Failed to delete Pi session')
}

export async function renameSession(sessionId: string, name: string) {
  const response = await fetch(sessionUrl(sessionId), {
    body: JSON.stringify({ name }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })
  if (!response.ok) throw new Error('Failed to rename Pi session')
}

export async function fetchSessionSettings(sessionId: string) {
  const body = await fetchJson<{ settings?: PiSettingsSnapshot }>(`${sessionUrl(sessionId)}/settings`)
  if (!body.settings) throw new Error('Invalid Pi settings response')
  return body.settings
}

export async function saveSessionSettings(sessionId: string, settings: Partial<PiRuntimeSettings>) {
  const response = await fetch(`${sessionUrl(sessionId)}/settings`, { body: JSON.stringify(settings), headers: { 'content-type': 'application/json' }, method: 'PATCH' })
  if (!response.ok) throw new Error('Failed to save Pi settings')
  const body = await response.json() as { settings?: PiSettingsSnapshot }
  if (!body.settings) throw new Error('Invalid Pi settings response')
  return body.settings
}
