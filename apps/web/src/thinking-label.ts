export function thinkingLabel(level: string) {
  return ({ off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '最高' } as Record<string, string>)[level] ?? level
}
