import { describe, expect, it } from 'vitest'

import { dialogFrom, isCustomAnswerEditor, isCustomAnswerSelection, planImplementationPrompt, planActionOptions, readExtensionPresentation, selectResponse } from './runtime-extension-event.js'

function notice(message: string, notifyType = 'info') {
  return readExtensionPresentation({ sessionId: 'session-1', sequence: 1, observedAt: 'now', event: { type: 'extension_ui_request', method: 'notify', message, notifyType } })
}

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
    expect(notice('Questionnaire failed: option that was not offered')).toEqual({ kind: 'questionnaire_error', text: 'Questionnaire failed: option that was not offered' })
    expect(notice('Plan ready')).toEqual({ kind: 'notice', level: 'info', text: 'Plan ready' })
  })

  it('suppresses only the duplicated Plan-mode lifecycle notice', () => {
    expect(notice('Plan mode enabled. I will explore and plan, but not modify files.')).toBeUndefined()
    expect(notice('Plan mode is already active.')).toMatchObject({ kind: 'notice' })
  })

  it('suppresses Ponytail loading success while preserving warnings, errors, and other notices', () => {
    for (const level of ['lite', 'full', 'ultra']) {
      expect(notice(`Ponytail loaded: ${level}`)).toBeUndefined()
    }
    expect(notice('Ponytail loaded: full', 'warning')).toMatchObject({ kind: 'notice' })
    expect(notice('Ponytail loaded: full', 'error')).toMatchObject({ kind: 'notice' })
    expect(notice('Ponytail failed to load', 'error')).toMatchObject({ kind: 'notice' })
    expect(notice('Another plugin loaded: full', 'info')).toMatchObject({ kind: 'notice' })
    expect(notice('Ponytail level changed: lite', 'info')).toMatchObject({ kind: 'notice' })
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

it('only replaces the known plan action menu and preserves every exact RPC option', () => {
  const options = ['Implement here', 'Start fresh and implement', 'Export plan…', 'Save for later', 'Stay in Plan mode', 'Discard plan and exit', 'Plugin-specific action']
  const plan = dialogFrom({ ...selectEvent(options), event: { ...selectEvent(options).event, title: 'Proposed plan ready. What next? Long explanation.' } })!
  const actions = planActionOptions(plan)!
  expect(actions.primary.map(({ kind, rawValue, displayLabel }) => [kind, rawValue, displayLabel])).toEqual([
    ['implement_here', options[0], '在当前会话执行'], ['implement_fresh', options[1], '新建会话执行'],
  ])
  expect(actions.more.map((option) => option.rawValue)).toEqual(options.slice(2))
  expect(actions.more[0]?.menuLabel).toBe('导出计划')
  expect(planActionOptions(dialogFrom(selectEvent(options))!)).toBeUndefined()
  expect(planActionOptions({ ...plan, options: plan.options!.slice(0, 1) })).toBeUndefined()
})
