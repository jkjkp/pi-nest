import { describe, expect, it } from 'vitest'

import { createSessionActivity } from './session-activity.js'

describe('session activity', () => {
  it('keeps prompts and mutations mutually exclusive until their own cleanup runs', () => {
    const activity = createSessionActivity()

    const prompt = activity.beginPrompt('session-1')
    expect(prompt).toBeInstanceOf(AbortController)
    expect(activity.beginPrompt('session-1')).toBeUndefined()
    expect(activity.beginMutation('session-1')).toBeUndefined()

    activity.finishPrompt('session-1', prompt!)
    const finishMutation = activity.beginMutation('session-1')
    expect(finishMutation).toBeTypeOf('function')
    expect(activity.beginPrompt('session-1')).toBeUndefined()

    finishMutation!()
    expect(activity.beginPrompt('session-1')).toBeInstanceOf(AbortController)
  })

  it('aborts active prompts and never lets an old prompt release a newer one', () => {
    const activity = createSessionActivity()
    const first = activity.beginPrompt('session-1')!

    expect(activity.abortPrompt('session-1')).toBe(true)
    expect(first.signal.aborted).toBe(true)
    activity.finishPrompt('session-1', first)

    const second = activity.beginPrompt('session-1')!
    activity.finishPrompt('session-1', first)
    expect(activity.isPromptActive('session-1')).toBe(true)

    activity.finishPrompt('session-1', second)
    expect(activity.isPromptActive('session-1')).toBe(false)
    expect(activity.abortPrompt('session-1')).toBe(false)
  })
})
