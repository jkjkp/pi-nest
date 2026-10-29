import type { TextFilePageRequest, TextFileRead, TextFileStat, WorkspaceFileScope } from '@pi-nest/contracts'
import { configurationRequest } from './workspace-api.js'
export type TextFileSource = { sessionId: string; path: string; searchRoot?: string; scope?: WorkspaceFileScope }
function endpoint(source: TextFileSource, method: string) { return source.scope ? `/api/workspace-files/${method}` : `/api/sessions/${encodeURIComponent(source.sessionId)}/file-preview/${method}` }
function body(source: TextFileSource) { return source.scope ? { scope: source.scope, path: source.path } : { path: source.path, searchRoot: source.searchRoot } }
export function fetchTextFileStat(source: TextFileSource, signal: AbortSignal) {
  return configurationRequest<TextFileStat>(endpoint(source, 'stat'), { method: 'POST', body: JSON.stringify(body(source)), signal })
}
export function fetchTextFilePage(source: TextFileSource, request: TextFilePageRequest, signal: AbortSignal) {
  return configurationRequest<TextFileRead>(endpoint(source, 'text-page'), { method: 'POST', body: JSON.stringify({ ...body(source), ...request }), signal })
}
