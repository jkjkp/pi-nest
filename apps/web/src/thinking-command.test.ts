import { expect, it } from 'vitest'
import { thinkingCommand, thinkingLabel } from './thinking-command.js'

it('recognizes only standalone thinking commands and preserves normal prompts', () => {
  expect(thinkingCommand(' /thinking ')).toEqual({ level: undefined })
  expect(thinkingCommand('/thinking HIGH')).toEqual({ level: 'high' })
  expect(thinkingCommand('/thinking strange')).toEqual({ level: 'strange' })
  expect(thinkingCommand('/thinking high\nexplain')).toBeUndefined()
  expect(thinkingCommand('explain /thinking high')).toBeUndefined()
  expect(thinkingCommand('/thinking-high')).toBeUndefined()
})

it('labels known levels and preserves future Pi levels', () => {
  expect(thinkingLabel('off')).toBe('关闭')
  expect(thinkingLabel('high')).toBe('高')
  expect(thinkingLabel('future')).toBe('future')
})
