import type { PiSessionHistoryResponse } from './history.js'
import type { PiSessionSummary } from './workspace.js'

export type PiRuntimeSettings = {
  compactionEnabled: boolean
  defaultModel?: string
  defaultProvider?: string
  defaultThinkingLevel?: string
  followUpMode: 'all' | 'one-at-a-time'
  retryEnabled: boolean
  steeringMode: 'all' | 'one-at-a-time'
}
export type PiSettingsSnapshot = { effective: PiRuntimeSettings; global: PiRuntimeSettings; project: Partial<PiRuntimeSettings> }

async function fetchJson<T>(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
  return (await response.json()) as T
}

function sessionUrl(sessionId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}`
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
