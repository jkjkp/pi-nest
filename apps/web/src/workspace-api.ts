import { useWorkspaceStore } from './workspace-store.js'
import type { PiProject, PiSessionInitialSettings, PiSessionBranchRequest, PiSessionBranchResponse, PiRuntimeSettings, PiSettingsSnapshot, PiSessionsResponse } from '@pi-nest/contracts'
import { historyPageSize, type PiSessionHistoryResponse, type PiSessionTurnIndex } from './history.js'
import type { PiSessionSummary } from './workspace.js'
import { runtimeBootstrap } from './runtime-bootstrap.js'

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
  useWorkspaceStore.getState().setBranchStorage(body.branchStorage ?? { available: true })
  return body.sessions
}

export async function createSession(cwd: string, prompt: string, attachments?: { attachmentIds: string[]; submissionId: string; draftId: string }, initialSettings?: PiSessionInitialSettings) {
  const body = await configurationRequest<{ session?: PiSessionSummary; disposition?: 'handled' | 'started' | 'queued' }>('/api/sessions', { body: JSON.stringify({ cwd, prompt, ...attachments, ...(initialSettings ? { initialSettings } : {}) }), method: 'POST' })
  if (!body.session?.id || !body.session.cwd) throw new Error('Invalid Pi session creation response')
  return { ...body.session, ...(body.disposition ? { disposition: body.disposition } : {}) }
}

export async function openProjectFolder(cwd: string) {
  await configurationRequest('/api/projects/reveal', { body: JSON.stringify({ cwd }), method: 'POST' })
}

export async function deleteSession(sessionId: string) {
  const response = await fetch(sessionUrl(sessionId), { method: 'DELETE' })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : '删除会话失败，请稍后重试。'), { status: response.status, code: body?.code })
  }
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
  let credentials = await runtimeBootstrap.get(init.signal ?? undefined)
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted()
    const headers = new Headers(init.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    headers.set('x-pi-nest-token', credentials.token)
    const response = await fetch(path, { ...init, headers, cache: 'no-store' })
    if (response.ok) return response
    const body = await response.json().catch(() => undefined)
    init.signal?.throwIfAborted()
    if (response.status === 403 && body?.code === 'RUNTIME_TOKEN_INVALID') {
      if (attempt === 0) {
        credentials = await runtimeBootstrap.refresh(credentials, init.signal ?? undefined)
        if (!(init.body instanceof ReadableStream)) continue
      } else runtimeBootstrap.invalidate(credentials)
    }
    throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : '请求失败，请重试。'), { code: body?.code, sessionId: body?.sessionId })
  }
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

export function fetchBranchOperation(sessionId: string, operationId: string) {
  return configurationRequest<import('@pi-nest/contracts').PiBranchOperation>(`${sessionUrl(sessionId)}/branch-operations/${encodeURIComponent(operationId)}`)
}

export async function branchSession(sessionId: string, request: PiSessionBranchRequest) {
  const operationId = request.operationId ?? crypto.randomUUID()
  let response: Response
  try { response = await fetch(`${sessionUrl(sessionId)}/branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, operationId }) }) }
  catch { throw Object.assign(new Error('分支结果待确认，请查询结果，避免重复创建。'), { uncertain: true }) }
  let body: PiSessionBranchResponse & { error?: string; state?: string }
  try { body = await response.json() as typeof body }
  catch { throw Object.assign(new Error('分支回执无法读取，请查询结果，避免重复创建。'), { uncertain: true }) }
  if (response.status === 202 || body.state) throw Object.assign(new Error('分支结果待确认，请查询结果。'), { uncertain: true })
  if (!response.ok) throw Object.assign(new Error(body.error ?? '创建分支失败，请重试。'), { uncertain: response.status >= 500 && response.status !== 503 })
  if (!body.session?.id || body.session.id === sessionId || typeof body.draft !== 'string') throw Object.assign(new Error('分支结果待确认，请查询结果。'), { uncertain: true })
  return body
}

export function fetchSessionGraph(sessionId: string, signal?: AbortSignal) {
  return configurationRequest<import('@pi-nest/contracts').PiSessionGraph>(`${sessionUrl(sessionId)}/graph`, { signal })
}
export async function fetchProjects() {
  const body = await configurationRequest<{ projects: PiProject[] }>('/api/projects')
  return body.projects
}

export async function addProject(request: { kind: 'open'; cwd: string } | { kind: 'create'; parent: string; name: string }) {
  const body = await configurationRequest<{ project: PiProject }>('/api/projects', { method: 'POST', body: JSON.stringify(request) })
  return body.project
}


export async function selectProjectFolder(cwd?: string, signal?: AbortSignal) {
  const body = await configurationRequest<{ cwd: string | null }>('/api/projects/select-folder', { method: 'POST', body: JSON.stringify(cwd ? { cwd } : {}), signal })
  return body.cwd
}

export function fetchSessionFilePreview(sessionId: string, path: string, signal?: AbortSignal, searchRoot?: string) {
  return configurationRequest<import('@pi-nest/contracts').PiSessionFilePreview>(`${sessionUrl(sessionId)}/file-preview`, { method: 'POST', body: JSON.stringify({ path, searchRoot }), signal })
}

export async function fetchSessionImagePreview(sessionId: string, path: string, signal?: AbortSignal, searchRoot?: string) {
  const response = await configurationResponse(`${sessionUrl(sessionId)}/file-preview/image`, { method: 'POST', body: JSON.stringify({ path, searchRoot }), signal })
  return { path: decodeURIComponent(response.headers.get('x-pi-nest-file-path') ?? encodeURIComponent(path)), blob: await response.blob() }
}
