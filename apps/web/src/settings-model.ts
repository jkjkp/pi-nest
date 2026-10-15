import { Boxes, Cable, Cpu, KeyRound, Settings2, SlidersHorizontal } from 'lucide-react'

export const settingsCategories = [
  { id: 'models', label: '模型与运行', icon: Cpu, description: '设置新会话的默认模型与运行方式。' },
  { id: 'credentials', label: 'API 与认证', icon: KeyRound, description: '管理提供商凭据，与 Pi CLI 共用认证配置。' },
  { id: 'custom-models', label: '自定义模型', icon: Boxes, description: '连接兼容端点、本地模型，或覆盖内置模型参数。' },
  { id: 'mcp', label: 'MCP 服务', icon: Cable, description: '配置本地和远程 MCP 服务，使用 Pi 原生工具接入。' },
  { id: 'resources', label: '扩展与资源', icon: Settings2, description: '配置 Pi packages、扩展、Skills、提示词模板与主题。' },
  { id: 'advanced', label: '高级设置', icon: SlidersHorizontal, description: '调整模型传输、模型轮换范围和资源行为。' },
] as const

export function changedSettings<T extends object>(before: T, after: T): Partial<T> {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => !settingsEqual(value, before[key as keyof T]))) as Partial<T>
}

export function settingsEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => settingsEqual(value, right[index]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const a = Object.entries(left).filter(([, value]) => value !== undefined)
  const b = Object.entries(right).filter(([, value]) => value !== undefined)
  return a.length === b.length && a.every(([key, value]) => Object.hasOwn(right, key) && settingsEqual(value, (right as Record<string, unknown>)[key]))
}

export function jsonDraftChanged(before: unknown, text: string): boolean {
  try { return !settingsEqual(before, JSON.parse(text)) } catch { return true }
}

export function secondsToMilliseconds(text: string): number | undefined {
  if (!/^\d+(?:\.\d{1,3})?$/.test(text.trim())) return undefined
  const [seconds, fraction = ''] = text.trim().split('.')
  const result = Number(seconds) * 1000 + Number(fraction.padEnd(3, '0'))
  return Number.isSafeInteger(result) && result >= 0 && result <= 3_600_000 ? result : undefined
}
