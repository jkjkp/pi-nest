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
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key as keyof T]))) as Partial<T>
}
