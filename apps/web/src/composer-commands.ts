import type { PiSessionHistoryEntry } from './history.js'
import type { RuntimeTurn } from './session-run-model.js'
import type { PiRuntimeCommand } from '@pi-nest/contracts'

export const composerCommands = [
  { name: 'thinking', description: '调整思考等级 · /thinking [level]' },
  { name: 'model', description: '选择模型 · /model [provider/modelId]' },
  { name: 'compact', description: '压缩上下文 · /compact [说明]' },
  { name: 'name', description: '重命名会话 · /name [名称]' },
  { name: 'session', description: '查看会话用量与上下文' },
  { name: 'copy', description: '复制最近已完成的助手消息' },
  { name: 'settings', description: '打开当前会话设置' },
] as const

export function parseComposerCommand(value: string) {
  const match = value.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/)
  const command = composerCommands.find((command) => command.name === match?.[1]?.toLowerCase())
  return command ? { name: command.name, argument: match?.[2]?.trim() ?? '' } : undefined
}

export type CommandToken = { start: number; end: number; query: string }

export function commandToken(value: string, start: number, end = start): CommandToken | undefined {
  if (start !== end || (start < value.length && !/\s/.test(value[start]!))) return undefined
  const match = value.slice(0, start).match(/(?:^|\s)\/([^\s/]*)$/)
  return match ? { start: start - match[1]!.length - 1, end: start, query: match[1]! } : undefined
}

export function matchingCommands(commands: PiRuntimeCommand[], query: string) {
  const unique = new Map<string, Pick<PiRuntimeCommand, 'name' | 'description'>>(composerCommands.map((command) => [command.name, command]))
  for (const command of commands) if (!unique.has(command.name)) unique.set(command.name, command)
  return [...unique.values()].filter((command) => command.name.toLowerCase().startsWith(query.toLowerCase()))
}

export function completeCommand(value: string, token: CommandToken, name: string) {
  const suffix = value.slice(token.end)
  const replacement = `/${name}${/^\s/.test(suffix) ? '' : ' '}`
  return { value: value.slice(0, token.start) + replacement + suffix, caret: token.start + name.length + 2 }
}

export function lastCompletedAssistantText(entries: PiSessionHistoryEntry[], turns: RuntimeTurn[]) {
  const messages = entries.filter((entry) => entry.type === 'message').map((entry) => ({ message: entry.raw.message, timestamp: entry.timestamp }))
  for (const turn of turns) {
    if (!turn.completedAt) continue
    for (const { event, observedAt } of turn.events) {
      if (event.type === 'message_end' || event.type === 'message') messages.push({ message: event.message, timestamp: observedAt })
    }
  }
  const candidates = messages.flatMap(({ message, timestamp }) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return []
    const value = message as Record<string, unknown>
    if (value.role !== 'assistant' || value.stopReason === 'error' || value.stopReason === 'aborted') return []
    const text = typeof value.content === 'string' ? value.content : Array.isArray(value.content)
      ? value.content.flatMap((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n') : ''
    return text.trim() ? [{ text, timestamp }] : []
  })
  return candidates.sort((left, right) => left.timestamp.localeCompare(right.timestamp)).at(-1)?.text
}
