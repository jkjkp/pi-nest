import type { TextFileCursor } from '@pi-nest/contracts'
export type FilePreviewPanel = { open: boolean; tabs: FilePreviewSelection[]; activeTab?: string; expanded: string[]; scrollTop: number }
export const emptyFilePanel = (): FilePreviewPanel => ({ open: false, tabs: [], expanded: [], scrollTop: 0 })
export function fileTabKey(file: Pick<FilePreviewSelection, 'path' | 'searchRoot'>) { return JSON.stringify([file.path, file.searchRoot ?? null]) }

export type FilePreviewSelection = { path: string; searchRoot?: string; line?: number; workspace?: boolean; navigation: number }
export type FileReadingPosition = { start: number; scrollTop: number; scrollLeft: number; mode: 'source' | 'reading'; target?: number; zoom: number | 'fit'; navigation?: number; pageCursor?: TextFileCursor }

export function filePreviewKey(sessionId: string, path: string, searchRoot?: string) {
  return JSON.stringify([sessionId, searchRoot ?? null, path])
}

export function isPreviewImage(path: string) {
  return /\.(png|jpe?g|webp|gif)$/i.test(path)
}

export function localMarkdownLink(filePath: string, href: string) {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href)) return undefined
  const [destination, fragment] = href.split('#', 2)
  let path: string
  try { path = decodeURIComponent(destination!.split('?')[0]!) } catch { return undefined }
  if (!path || /[\\\0]/.test(path)) return undefined
  const line = fragment?.match(/^L([1-9]\d*)(?:-L?[1-9]\d*)?$/)?.[1]
  // Preserve parent segments for the server to resolve against the current file directory.
  return { path: path.startsWith('/') ? path : `${filePath.slice(0, filePath.lastIndexOf('/') + 1)}${path}`, line: line && Number.isSafeInteger(Number(line)) ? Number(line) : undefined }
}


export function restoreFilePanels(value: unknown): Record<string, FilePreviewPanel> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, FilePreviewPanel> = {}
  for (const [key, raw] of Object.entries(value).slice(-100)) {
    if (!raw || typeof raw !== 'object' || key.length > 8192) continue
    const panel = raw as Partial<FilePreviewPanel>
    if (typeof panel.open !== 'boolean' || !Array.isArray(panel.tabs) || !Array.isArray(panel.expanded)) continue
    const tabs = panel.tabs.slice(-50).filter((file): file is FilePreviewSelection => !!file && typeof file.path === 'string' && file.path.length > 0 && file.path.length <= 4096 && !file.path.includes('\0') && (file.searchRoot === undefined || typeof file.searchRoot === 'string') && (file.line === undefined || Number.isSafeInteger(file.line) && file.line > 0) && Number.isSafeInteger(file.navigation) && file.navigation >= 0 && (file.workspace === undefined || typeof file.workspace === 'boolean')).map(file => ({ path: file.path, searchRoot: file.searchRoot, line: file.line, navigation: file.navigation, workspace: file.workspace }))
    result[key] = { open: panel.open, tabs, activeTab: tabs.some(file => fileTabKey(file) === panel.activeTab) ? panel.activeTab : undefined, expanded: panel.expanded.filter((path): path is string => typeof path === 'string' && path.length <= 4096 && !path.includes('\0')).slice(0, 128), scrollTop: typeof panel.scrollTop === 'number' && Number.isFinite(panel.scrollTop) && panel.scrollTop >= 0 ? panel.scrollTop : 0 }
  }
  return result
}

export function restoreFilePositions(value: unknown): Record<string, FileReadingPosition> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).slice(-200).filter(([key, raw]) => {
    try { const parts = JSON.parse(key); if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== 'string' || typeof parts[2] !== 'string') return false } catch { return false }
    if (!raw || typeof raw !== 'object') return false
    const p = raw as FileReadingPosition
    return [p.start, p.scrollTop, p.scrollLeft].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) && ['source', 'reading'].includes(p.mode) && (p.zoom === 'fit' || typeof p.zoom === 'number' && Number.isFinite(p.zoom) && p.zoom > 0)
  }).map(([key, raw]) => {
    const p = raw as FileReadingPosition
    return [key, { start: p.start, scrollTop: p.scrollTop, scrollLeft: p.scrollLeft, mode: p.mode, zoom: p.zoom, ...(Number.isSafeInteger(p.target) && p.target! >= 0 ? { target: p.target } : {}), ...(validTextCursor(p.pageCursor) ? { pageCursor: { offset: p.pageCursor!.offset, line: p.pageCursor!.line, midLine: p.pageCursor!.midLine, version: p.pageCursor!.version } } : {}), ...(Number.isSafeInteger(p.navigation) && p.navigation! >= 0 ? { navigation: p.navigation } : {}) }]
  })) as Record<string, FileReadingPosition>
}

function validTextCursor(value: unknown): value is TextFileCursor {
  if (!value || typeof value !== 'object') return false
  const c = value as TextFileCursor
  return Number.isSafeInteger(c.offset) && c.offset >= 0 && Number.isSafeInteger(c.line) && c.line >= 1 && typeof c.midLine === 'boolean' && c.line <= c.offset + 1 && (c.offset !== 0 || !c.midLine && c.line === 1) && typeof c.version === 'string' && c.version.length > 0 && c.version.length <= 256
}
