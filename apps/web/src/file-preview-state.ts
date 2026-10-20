export type FilePreviewSelection = { path: string; searchRoot?: string; line?: number; open: boolean; navigation: number }
export type FileReadingPosition = { start: number; scrollTop: number; scrollLeft: number; mode: 'source' | 'reading'; target?: number; zoom: number | 'fit'; navigation?: number }

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
