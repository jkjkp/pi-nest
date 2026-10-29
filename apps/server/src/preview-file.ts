import { isWorkspacePath } from './workspace-file-path.js'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

export class PreviewError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 415, readonly code?: string) { super(message) }
}

export async function openPreviewFile(cwd: string, path: string, searchRoot?: string, allowedRoot?: string) {
  // A missing session directory must not prevent opening an absolute path.
  const root = await realpath(cwd).catch(() => resolve(cwd))
  let requested = resolve(root, path)
  if (searchRoot !== undefined && !isAbsolute(path)) {
    const scope = resolve(root, searchRoot)
    const canonicalScope = await realpath(scope)
    const scopeInfo = await stat(canonicalScope)
    if (scopeInfo.isFile()) {
      if (path !== basename(scope)) throw new PreviewError('搜索结果与文件范围不匹配。', 400)
      requested = canonicalScope
    } else if (scopeInfo.isDirectory()) {
      requested = resolve(canonicalScope, path)
    } else throw new PreviewError('搜索范围不是文件或目录。', 400)
  }
  const canonical = await realpath(requested)
  if (allowedRoot && !isWorkspacePath(allowedRoot, canonical)) throw new PreviewError('文件位于项目范围之外。', 403)
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat({ bigint: true })
    if (!info.isFile()) throw new PreviewError('此路径不是普通文件。', 400)
    // Recheck identity after opening; never read a replaced path's descriptor.
    const current = await realpath(canonical)
    if (allowedRoot && !isWorkspacePath(allowedRoot, current)) throw new PreviewError('文件位于项目范围之外。', 403)
    const currentInfo = await stat(current, { bigint: true })
    if (info.dev !== currentInfo.dev || info.ino !== currentInfo.ino) throw new PreviewError('文件已变化，请重试。', 400)
    const child = relative(root, canonical)
    const outside = isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)
    return { path: outside ? canonical : child, canonical, file, info, allowedRoot }
  } catch (error) { await file.close(); throw error }
}

