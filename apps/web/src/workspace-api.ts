import type { PiProject, PiSessionInitialSettings, PiSessionBranchRequest, PiSessionBranchResponse, PiRuntimeSettings, PiSettingsSnapshot, PiSessionsResponse } from '@pi-nest/contracts'
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

export function fetchSessionTurnIndex(sessionId: string, revision?: string, signal?: AbortSignal) {
  return fetchJson<PiSessionTurnIndex>(`${sessionUrl(sessionId)}/turn-index${revision ? `?${new URLSearchParams({ revision })}` : ''}`, signal)
}

export async function fetchSessions() {
  const body = await fetchJson<Partial<PiSessionsResponse>>('/api/sessions')
  if (!Array.isArray(body.sessions)) throw new Error('Invalid session list response')
  return body.sessions
}

export async function createSession(cwd: string, prompt: string, attachments?: { attachmentIds: string[]; submissionId: string; draftId: string }, initialSettings?: PiSessionInitialSettings) {
  const body = await configurationRequest<{ session?: PiSessionSummary }>('/api/sessions', { body: JSON.stringify({ cwd, prompt, ...attachments, ...(initialSettings ? { initialSettings } : {}) }), method: 'POST' })
  if (!body.session?.id || !body.session.cwd) throw new Error('Invalid Pi session creation response')
  return body.session
}

export async function openProjectFolder(cwd: string) {
  await configurationRequest('/api/projects/reveal', { body: JSON.stringify({ cwd }), method: 'POST' })
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
  const body = await configurationRequest<{ settings?: PiSettingsSnapshot }>(`${sessionUrl(sessionId)}/settings`)
  if (!body.settings) throw new Error('Invalid Pi settings response')
  return body.settings
}

export async function saveSessionSettings(sessionId: string, settings: Partial<PiRuntimeSettings>) {
  const body = await configurationRequest<{ settings?: PiSettingsSnapshot }>(`${sessionUrl(sessionId)}/settings`, { body: JSON.stringify(settings), method: 'PATCH' })
  if (!body.settings) throw new Error('Invalid Pi settings response')
  return body.settings
}

export async function configurationResponse(path: string, init: RequestInit = {}) {
  const bootstrap = await fetch('/api/runtime/bootstrap', { method: 'POST', signal: init.signal })
  if (!bootstrap.ok) throw new Error('无法验证访问权限')
  const { token } = await bootstrap.json() as { token: string }
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', 'x-pi-nest-token': token, ...init.headers }, cache: 'no-store' })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : '请求失败，请重试。'), { code: body?.code, sessionId: body?.sessionId })
  }
  return response
}

export async function configurationRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await configurationResponse(path, init)
  return (response.status === 204 ? undefined : await response.json()) as T
}

export function fetchPiConfiguration(sessionId?: string, project?: string) {
  return configurationRequest<import('@pi-nest/contracts').PiConfigurationSnapshot>(`/api/configuration${project ? `?${new URLSearchParams({ project })}` : sessionId ? `?${new URLSearchParams({ session: sessionId })}` : ''}`)
}

export function savePiConfiguration(update: import('@pi-nest/contracts').PiConfigurationUpdate, sessionId?: string) {
  return configurationRequest<{ saved: true }>(`/api/configuration${sessionId ? `?${new URLSearchParams({ session: sessionId })}` : ''}`, { method: 'PATCH', body: JSON.stringify(update) })
}

export function testPiMcp(sessionId?: string) {
  return configurationRequest<import('@pi-nest/contracts').PiMcpDiagnostics>(`/api/configuration/mcp/test${sessionId ? `?${new URLSearchParams({ session: sessionId })}` : ''}`, { method: 'POST' })
}


export function discoverProviderModels(request: import('@pi-nest/contracts').PiModelDiscoveryRequest) {
  return configurationRequest<{ models: import('@pi-nest/contracts').PiDiscoveredModel[] }>('/api/configuration/models/discover', { method: 'POST', body: JSON.stringify(request) })
}

export async function branchSession(sessionId: string, request: PiSessionBranchRequest) {
  const response = await fetch(`${sessionUrl(sessionId)}/branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    throw new Error(typeof body?.error === 'string' ? body.error : '创建分支会话失败，请重试。')
  }
  const body = await response.json() as PiSessionBranchResponse
  if (!body.session?.id || body.session.id === sessionId || typeof body.draft !== 'string') throw new Error('分支会话返回数据无效，请刷新会话列表。')
  return body
}


export async function fetchProjects() {
  const body = await configurationRequest<{ projects: PiProject[] }>('/api/projects')
  return body.projects
}

export async function addProject(request: { kind: 'open'; cwd: string } | { kind: 'create'; parent: string; name: string }) {
  const body = await configurationRequest<{ project: PiProject }>('/api/projects', { method: 'POST', body: JSON.stringify(request) })
  return body.project
}


export async function selectProjectFolder(cwd?: string) {
  const body = await configurationRequest<{ cwd: string | null }>('/api/projects/select-folder', { method: 'POST', body: JSON.stringify(cwd ? { cwd } : {}) })
  return body.cwd
}

export function fetchSessionFilePreview(sessionId: string, path: string, signal?: AbortSignal, searchRoot?: string) {
  return configurationRequest<import('@pi-nest/contracts').PiSessionFilePreview>(`${sessionUrl(sessionId)}/file-preview`, { method: 'POST', body: JSON.stringify({ path, searchRoot }), signal })
}

export async function fetchSessionImagePreview(sessionId: string, path: string, signal?: AbortSignal, searchRoot?: string) {
  const response = await configurationResponse(`${sessionUrl(sessionId)}/file-preview/image`, { method: 'POST', body: JSON.stringify({ path, searchRoot }), signal })
  return { path: decodeURIComponent(response.headers.get('x-pi-nest-file-path') ?? encodeURIComponent(path)), blob: await response.blob() }
}
