export function thinkingCommand(text: string) {
  if (/[\r\n]/.test(text)) return undefined
  const match = text.trim().match(/^\/thinking(?:\s+(.*))?$/i)
  return match ? { level: match[1]?.trim().toLowerCase() } : undefined
}

export function thinkingLabel(level: string) {
  return ({ off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '最高' } as Record<string, string>)[level] ?? level
}
