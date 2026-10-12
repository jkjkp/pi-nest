import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { modelCallError, modelCallErrorLabel } from './model-call-error.js'
import { ModelCallErrorNotice } from './model-call-error-notice.js'

it.each([
  ['No API key found for provider', '缺少模型凭据'],
  ['401 Unauthorized', '身份验证失败'],
  ['403: {"code":"1220","message":"您无权访问glm-5.3-highspeed。"}', '当前凭据无权访问 glm-5.3-highspeed'],
  ['429 quota exceeded', '额度不足'],
  ['429 rate limit', '请求过于频繁'],
  ['fetch failed', '连接失败'],
  ['unknown failure', '查看详情'],
])('explains %s without treating every failure as a missing key', (message, label) => {
  expect(modelCallErrorLabel({ message, model: 'glm-5.3-highspeed' })).toContain(label)
})

it('renders a persistent per-turn notice, provider details and a model selection action', () => {
  const error = modelCallError({ role: 'assistant', stopReason: 'error', errorMessage: '403: code 1220', provider: 'zai-coding-cn', model: 'glm-5.3-highspeed' })!
  const markup = renderToStaticMarkup(<ModelCallErrorNotice error={error} onSelectModel={() => undefined} />)
  expect(markup).toContain('role="alert"')
  expect(markup).toContain('选择模型')
  expect(markup).toContain('查看详情')
  expect(markup).toContain('zai-coding-cn/glm-5.3-highspeed')
  expect(markup).toContain('403: code 1220')
  expect(modelCallError({ role: 'assistant', stopReason: 'stop' })).toBeUndefined()
  expect(modelCallError({ role: 'assistant', stopReason: 'error' })?.message).toBe('模型未返回错误详情。')
})
