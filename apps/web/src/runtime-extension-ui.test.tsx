import { describe, expect, it } from 'vitest'

import { dialogFrom, isCustomAnswerEditor, isCustomAnswerSelection, isPlanModeLifecycleNotice, isQuestionnaireFailure, planImplementationPrompt, selectResponse } from './runtime-extension-ui.js'

function selectEvent(options: string[]) {
  return {
    event: { id: 'dialog-1', method: 'select', options, title: 'Choose', type: 'extension_ui_request' },
    observedAt: 'now',
    sequence: 1,
    sessionId: 'session-1',
  }
}

describe('RuntimeExtensionUi select mapping', () => {
  it('defaults direct submission to the first exact Pi option value', () => {
    const dialog = dialogFrom(selectEvent(['first', 'second']))
    expect(selectResponse(dialog!)).toEqual({ value: 'first' })
  })

  it('returns the exact selected raw value for ANSI, long, duplicate, and special options', () => {
    const ansi = '\u001B[36mRecommended\u001B[0m\nDetails'
    const long = `A very long option ${'that wraps safely '.repeat(40)}`
    const duplicate = 'same value'
    const dialog = dialogFrom(selectEvent([ansi, long, duplicate, duplicate, 'quoted " & <>']))!

    expect(dialog.options).toEqual([
      { displayLabel: 'Recommended\nDetails', rawValue: ansi },
      { displayLabel: long, rawValue: long },
      { displayLabel: duplicate, rawValue: duplicate },
      { displayLabel: duplicate, rawValue: duplicate },
      { displayLabel: 'quoted " & <>', rawValue: 'quoted " & <>' },
    ])
    expect(selectResponse({ selectedValue: long })).toEqual({ value: long })
    expect(selectResponse({ selectedValue: ansi })).toEqual({ value: ansi })
    expect(selectResponse({ selectedValue: 'quoted " & <>' })).toEqual({ value: 'quoted " & <>' })
  })

  it('does not submit a select dialog with no Pi options', () => {
    expect(selectResponse(dialogFrom(selectEvent([]))!)).toBeUndefined()
  })

  it('only maps the Plan implementation action to Pi CLI’s user prompt', () => {
    const plan = dialogFrom({
      event: { id: 'plan', method: 'select', options: ['Implement here', 'Start fresh and implement'], title: 'Proposed plan ready. What next?', type: 'extension_ui_request' },
      observedAt: 'now', sequence: 1, sessionId: 'session-1',
    })!
    const ordinary = dialogFrom(selectEvent(['Implement here', 'Start fresh and implement']))!

    expect(planImplementationPrompt(plan, { value: 'Implement here' })).toBe('Implement the plan.')
    expect(planImplementationPrompt(ordinary, { value: 'Implement here' })).toBeUndefined()
  })

  it('keeps Questionnaire protocol failures out of the generic notification path', () => {
    expect(isQuestionnaireFailure('Questionnaire failed: option that was not offered')).toBe(true)
    expect(isQuestionnaireFailure('Plan ready')).toBe(false)
  })

  it('suppresses only the duplicated Plan-mode lifecycle notice', () => {
    expect(isPlanModeLifecycleNotice('Plan mode enabled. I will explore and plan, but not modify files.')).toBe(true)
    expect(isPlanModeLifecycleNotice('Plan mode is already active.')).toBe(false)
  })
})

it('recognizes the custom-answer entry without changing the exact RPC selection', () => {
  const raw = '\u001b[36m5. Other (free-form)\u001b[0m'
  const dialog = dialogFrom(selectEvent(['1. Research', raw]))!
  expect(isCustomAnswerSelection(dialog)).toBe(false)
  dialog.selectedValue = raw
  dialog.value = '自定义方案'
  expect(isCustomAnswerSelection(dialog)).toBe(true)
  expect(selectResponse(dialog)).toEqual({ value: raw })
  expect(isCustomAnswerSelection(dialogFrom(selectEvent(['Other project']))!)).toBe(false)
})

it('accepts the follow-up editor request and preserves its draft', () => {
  const dialog = dialogFrom({ event: { id: 'editor', type: 'extension_ui_request', method: 'editor', title: 'Your answer', prefill: 'Existing draft' }, observedAt: 'now', sequence: 2, sessionId: 'session-1' })!
  expect(dialog).toMatchObject({ method: 'editor', value: 'Existing draft', prefill: 'Existing draft' })
})

it('requires a nonblank custom answer while allowing an ordinary choice with a saved draft', () => {
  const dialog = dialogFrom(selectEvent(['1. Research', '2. Other (free-form)']))!
  dialog.selectedValue = '2. Other (free-form)'
  expect(selectResponse(dialog)).toBeUndefined()
  dialog.value = '   '
  expect(selectResponse(dialog)).toBeUndefined()
  dialog.value = 'My research plan'
  expect(selectResponse(dialog)).toEqual({ value: '2. Other (free-form)' })
  dialog.selectedValue = '1. Research'
  expect(selectResponse(dialog)).toEqual({ value: '1. Research' })
  expect(dialog.value).toBe('My research plan')
})

it('only bridges the matching questionnaire editor in the same session and run', () => {
  const question = { sessionId: 'session-1', runId: 'run-1', title: '交付物: 最终要交付什么？' }
  const editor = { sessionId: 'session-1', runId: 'run-1', title: '最终要交付什么？', method: 'editor' as const }
  expect(isCustomAnswerEditor(question, editor)).toBe(true)
  expect(isCustomAnswerEditor(question, { ...editor, sessionId: 'session-2' })).toBe(false)
  expect(isCustomAnswerEditor(question, { ...editor, runId: 'run-2' })).toBe(false)
  expect(isCustomAnswerEditor(question, { ...editor, title: '其他问题' })).toBe(false)
  expect(isCustomAnswerEditor(question, { ...editor, method: 'input' })).toBe(false)
})
