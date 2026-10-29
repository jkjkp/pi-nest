import path from 'node:path'

export function isWorkspacePath(root: string, target: string, paths = path) {
  const child = paths.relative(root, target)
  return !paths.isAbsolute(child) && child !== '..' && !child.startsWith(`..${paths.sep}`)
}
