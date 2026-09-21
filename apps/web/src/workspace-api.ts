import type { PiSessionHistoryResponse } from './history.js'
import type { PiSessionSummary } from './workspace.js'

export type HealthResponse = { status?: string }

async function fetchJson<T>(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
  return (await response.json()) as T
}

function sessionUrl(sessionId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}`
}

export function fetchHealth() {
  return fetchJson<HealthResponse>('/api/health')
}

export function fetchSessionHistory(sessionId: string) {
  return fetchJson<PiSessionHistoryResponse>(`${sessionUrl(sessionId)}/history`)
}

export async function fetchSessions() {
  const body = await fetchJson<{ sessions?: PiSessionSummary[] }>('/api/sessions')
  if (!Array.isArray(body.sessions)) throw new Error('Invalid session list response')
  return body.sessions
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
