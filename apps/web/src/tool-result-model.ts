import type { PiFileChange } from '@pi-nest/contracts'
import { toolStatus, type TimelinePart } from './timeline-model.js'

export type ToolResult = {
  name: string
  view: 'read' | 'edit' | 'write' | 'grep' | 'bash' | 'generic'
  args: Record<string, unknown>
  status: string
  output: string
  command?: string
  cwd?: string
  written?: string
  readOffset?: number
  readLimit?: number
  searchPattern?: string
  searchGlob?: string
  searchIncludesContext?: boolean
  exitCode?: number
  fileLine?: number
  path?: string
  diff?: string
  patch?: string
  changes?: { added: number; removed: number }
  fileChange?: PiFileChange
  notices: string[]
}

// Only complete, single-file unified patches can establish change totals.
export function patchChanges(patch: string): { added: number; removed: number } | undefined {
  let oldRemaining = 0, newRemaining = 0, added = 0, removed = 0, hunks = 0
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@.*$/.exec(line)
    if (hunk) {
      if (oldRemaining || newRemaining) return undefined
      oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1])
      newRemaining = hunk[2] === undefined ? 1 : Number(hunk[2])
      if (!Number.isSafeInteger(oldRemaining) || !Number.isSafeInteger(newRemaining)) return undefined
      hunks++
      continue
    }
    if (!hunks) {
      if (/^(diff --git |index |--- |\+\+\+ )/.test(line)) continue
      return undefined
    }
    if (line === '\\ No newline at end of file') continue
    if (line.startsWith('+')) { newRemaining--; added++ }
    else if (line.startsWith('-')) { oldRemaining--; removed++ }
    else if (line.startsWith(' ')) { oldRemaining--; newRemaining-- }
    else return undefined
    if (oldRemaining < 0 || newRemaining < 0) return undefined
  }
  return hunks && oldRemaining === 0 && newRemaining === 0 ? { added, removed } : undefined
}

export function projectToolResult(part: Extract<TimelinePart, { kind: 'tool' }>, settled = false): ToolResult {
  const args = part.arguments ?? {}
  const recordedStatus = toolStatus(part.events)
  const status = settled && recordedStatus === '正在执行' ? '结果未记录' : recordedStatus
  const final = part.events.findLast((event) => event.tool?.terminal)
  const latest = final ?? part.events.findLast((event) => event.tool?.partial)
  const payload = latest?.tool?.output
  const name = part.toolName
  const view = ['read', 'edit', 'write', 'grep', 'bash'].includes(name) ? name as ToolResult['view'] : 'generic'
  const successfulEdit = view === 'edit' && status === '完成'
  const patch = successfulEdit ? payload?.patch : undefined
  const diff = successfulEdit ? payload?.diff : undefined
  const readOffset = typeof args.offset === 'number' ? args.offset : undefined
  return {
    name, view, args, status, output: payload?.output ?? '', notices: payload?.notices ?? [],
    path: typeof args.path === 'string' ? args.path : undefined,
    command: typeof args.command === 'string' ? args.command : undefined,
    cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
    written: typeof args.content === 'string' ? args.content : undefined,
    readOffset, readLimit: typeof args.limit === 'number' ? args.limit : undefined,
    searchPattern: typeof args.pattern === 'string' ? args.pattern : undefined,
    searchGlob: typeof args.glob === 'string' ? args.glob : undefined,
    searchIncludesContext: Boolean(args.context && args.context !== 0),
    exitCode: payload?.exitCode, fileLine: payload?.firstChangedLine ?? (view === 'read' ? readOffset : undefined),
    patch, diff, fileChange: payload?.fileChange, changes: patch ? patchChanges(patch) : undefined,
  }
}

export type SearchMatch = { path: string; line: number; text: string }

export function searchMatches(result: ToolResult): SearchMatch[] | undefined {
  if (result.view !== 'grep' || result.status !== '完成' || result.searchIncludesContext || result.notices.length || !result.output) return undefined
  const rows = result.output.trimEnd().split('\n')
  const matches: SearchMatch[] = []
  for (const row of rows) {
    // Ambiguous delimiters (including in the matched source) retain the original output.
    if ([...row.matchAll(/:\d+: /g)].length !== 1) return undefined
    const match = /^(.+?):([1-9]\d*): (.*)$/.exec(row)
    if (!match || !Number.isSafeInteger(Number(match[2]))) return undefined
    matches.push({ path: match[1]!, line: Number(match[2]), text: match[3]! })
  }
  return matches
}
