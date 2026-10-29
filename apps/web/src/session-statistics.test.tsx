import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SessionStatistics } from './session-statistics.js'

const data = { tokens: { input: 257000, output: 149000, cacheRead: 17000000, cacheWrite: 0, total: 17406000 }, cost: 0.357, contextUsage: { tokens: 197000, percent: 19.7, contextWindow: 1000000 }, autoCompactionEnabled: true, cacheHitRate: 99.9 }

it('shows a proportional ring and keeps cost out of the compact trigger', () => {
  const markup = renderToStaticMarkup(<SessionStatistics details={{ data }} onRetry={() => undefined} />)
  expect(markup).toContain('19.7%')
  expect(markup).toContain('stroke-dasharray="19.7 100"')
  expect(markup).toContain('20%')
  expect(markup).not.toContain('0.357')
  expect(markup).not.toContain('刷新统计')
  expect(markup).toContain('会话用量与上下文')
  expect(markup).not.toContain('选择模型')
})

it('keeps unknown post-compaction context distinct from zero and retains the original color at capacity', () => {
  expect(renderToStaticMarkup(<SessionStatistics details={{ data: { ...data, contextUsage: { ...data.contextUsage, tokens: null, percent: null } } }} onRetry={() => undefined} />)).toContain('上下文用量待更新')
  expect(renderToStaticMarkup(<SessionStatistics details={{ data: { ...data, contextUsage: { ...data.contextUsage, percent: 100 } } }} onRetry={() => undefined} />)).not.toContain('text-destructive')
  expect(renderToStaticMarkup(<SessionStatistics onRetry={() => undefined} />)).not.toContain('0.0%')
})


it('clamps only the ring arc and distinguishes empty context from unknown', () => {
  const markup = renderToStaticMarkup(<SessionStatistics details={{ data: { ...data, contextUsage: { ...data.contextUsage, percent: 120 } } }} onRetry={() => undefined} />)
  expect(markup).toContain('stroke-dasharray="100 100"')
  expect(markup).toContain('120.0%')
  expect(renderToStaticMarkup(<SessionStatistics details={{ data: { ...data, contextUsage: { ...data.contextUsage, percent: 0 } } }} onRetry={() => undefined} />)).toContain('0%')
})
