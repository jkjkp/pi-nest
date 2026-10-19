import { expect, it } from 'vitest'
import { thinkingLabel } from './thinking-label.js'

it('labels known levels and preserves future Pi levels', () => {
  expect(thinkingLabel('off')).toBe('关闭')
  expect(thinkingLabel('high')).toBe('高')
  expect(thinkingLabel('future')).toBe('future')
})
