import type { WorkspaceDirectory, WorkspaceFileScope } from '@pi-nest/contracts'
import { configurationRequest, configurationResponse } from './workspace-api.js'

export function listWorkspaceFiles(scope: WorkspaceFileScope, path: string, offset: number, signal: AbortSignal) {
  return configurationRequest<WorkspaceDirectory>('/api/workspace-files/list', { method: 'POST', body: JSON.stringify({ scope, path, offset }), signal })
}
export async function previewWorkspaceFile(scope: WorkspaceFileScope, path: string, image: boolean, signal: AbortSignal) {
  const response = await configurationResponse(`/api/workspace-files/${image ? 'image' : 'preview'}`, { method: 'POST', body: JSON.stringify({ scope, path }), signal })
  if (!response.ok) { const error = await response.json(); throw new Error(error.error ?? '读取失败') }
  return image ? { kind: 'image' as const, blob: await response.blob(), path: decodeURIComponent(response.headers.get('X-Pi-Nest-File-Path') ?? path) } : { kind: 'text' as const, ...await response.json() as { path: string; content: string } }
}
export async function watchWorkspaceFiles(scope: WorkspaceFileScope, paths: string[], signal: AbortSignal, changed: () => void) {
  const response = await configurationResponse('/api/workspace-files/watch', { method: 'POST', body: JSON.stringify({ scope, paths }), signal })
  if (!response.ok || !response.body) throw new Error('自动刷新不可用，可手动刷新。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const event = JSON.parse(pending.slice(0, end)) as { type: string; message?: string }
        pending = pending.slice(end + 1)
        if (event.type === 'change' || event.type === 'ready') changed()
        if (event.type === 'error') throw new Error(event.message)
      }
    }
    if (!signal.aborted) throw new Error('自动刷新已断开，可手动刷新。')
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
