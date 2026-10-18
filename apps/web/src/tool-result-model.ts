import { toolStatus, type TimelinePart } from './timeline-model.js'

export type ToolResult = {
  name: string
  view: 'read' | 'edit' | 'write' | 'grep' | 'bash' | 'generic'
  args: Record<string, unknown>
  status: string
  output: string
  details: Record<string, unknown>
  path?: string
  diff?: string
  patch?: string
  changes?: { added: number; removed: number }
  notices: string[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    const value = record(block)
    return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('\n')
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
  const final = part.events.findLast((event) => event.event.type === 'tool_execution_end' || record(event.event.message)?.role === 'toolResult')
  const latest = final ?? part.events.findLast((event) => record(event.event.partialResult))
  const payload = record(latest?.event.message) ?? record(latest?.event.result) ?? record(latest?.event.partialResult)
  const details = record(payload?.details) ?? {}
  const name = part.toolName
  const view = ['read', 'edit', 'write', 'grep', 'bash'].includes(name) ? name as ToolResult['view'] : 'generic'
  let output = resultText(payload?.content)
  if (!output && latest?.event.error) output = typeof latest.event.error === 'string' ? latest.event.error : JSON.stringify(latest.event.error)
  const notices: string[] = []
  if (record(details.truncation)?.truncated === true) notices.push('工具返回的内容已截断')
  if (typeof details.matchLimitReached === 'number') notices.push(`已达到 ${details.matchLimitReached} 条匹配上限，并非全部结果`)
  if (details.linesTruncated === true) notices.push('部分匹配行已截断')
  if (typeof details.fullOutputPath === 'string') notices.push(`完整输出保存在 ${details.fullOutputPath}`)
  if (Array.isArray(payload?.content) && payload.content.some((block) => record(block)?.type !== 'text')) notices.push('结果包含非文本内容，此处仅展示文本')
  const successfulEdit = view === 'edit' && status === '完成'
  const patch = successfulEdit && typeof details.patch === 'string' ? details.patch : undefined
  const diff = successfulEdit && typeof details.diff === 'string' ? details.diff : undefined
  return { name, view, args, status, output, details, notices, path: typeof args.path === 'string' ? args.path : undefined, patch, diff, changes: patch ? patchChanges(patch) : undefined }
}

export type SearchMatch = { path: string; line: number; text: string }

export function searchMatches(result: ToolResult): SearchMatch[] | undefined {
  if (result.view !== 'grep' || result.status !== '完成' || result.args.context && result.args.context !== 0 || result.notices.length || !result.output) return undefined
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
