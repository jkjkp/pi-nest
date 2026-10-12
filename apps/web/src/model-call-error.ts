export type ModelCallError = { message: string; model?: string; provider?: string }

export function modelCallError(message: Record<string, unknown>): ModelCallError | undefined {
  if (message.role !== 'assistant' || message.stopReason !== 'error') return undefined
  return {
    message: typeof message.errorMessage === 'string' && message.errorMessage.trim() ? message.errorMessage : '模型未返回错误详情。',
    ...(typeof message.model === 'string' ? { model: message.model } : {}),
    ...(typeof message.provider === 'string' ? { provider: message.provider } : {}),
  }
}

export function modelCallErrorLabel(error: ModelCallError) {
  const text = error.message
  const model = error.model ?? '当前模型'
  if (/no api key|missing api key|api key.*not found|未配置.*密钥/i.test(text)) return '缺少模型凭据，请检查 Pi 的提供商配置或切换模型。'
  if (/\b401\b/.test(text)) return '模型身份验证失败，请检查凭据是否有效或已过期。'
  if (/\b403\b|无权访问/.test(text)) return `当前凭据无权访问 ${model}。请检查订阅套餐或切换模型。`
  if (/quota|insufficient|余额|额度|套餐.*用尽/i.test(text)) return '模型额度不足，请检查账户额度或切换模型。'
  if (/\b429\b|rate.limit|限流/i.test(text)) return '模型请求过于频繁，请稍后重试。'
  if (/timeout|timed out|network|fetch failed|ECONN|网络|超时/i.test(text)) return '模型连接失败，请检查网络后重试。'
  return '模型调用失败，请查看详情或切换模型。'
}
