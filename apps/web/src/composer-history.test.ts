import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent } from 'react'
import { moveComposerHistory, useComposerHistory } from './composer-history.js'

const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], index: 0, layouts: [] as (() => void)[] }))
vi.mock('react', () => ({
  useRef: (value: unknown) => hooks.refs[hooks.index++] ?? (hooks.refs[hooks.index - 1] = { current: value }),
  useLayoutEffect: (effect: () => void) => hooks.layouts.push(effect),
}))

beforeEach(() => { hooks.refs = []; hooks.index = 0; hooks.layouts = [] })

describe('composer message history', () => {
  const messages = [{ id: 'first', prompt: '第一条\n多行' }, { id: 'empty' }, { id: 'last', prompt: '最近一条' }]

  it('browses both directions and restores the original draft', () => {
    const last = moveComposerHistory(messages, undefined, '未发送草稿', 'up')!
    expect(last.value).toBe('最近一条')
    const first = moveComposerHistory(messages, last.position, last.value, 'up')!
    expect(first.value).toBe('第一条\n多行')
    expect(moveComposerHistory(messages, first.position, first.value, 'up')).toBeUndefined()
    const newer = moveComposerHistory(messages, first.position, first.value, 'down')!
    expect(newer.value).toBe('最近一条')
    expect(moveComposerHistory(messages, newer.position, newer.value, 'down')).toEqual({ value: '未发送草稿', position: undefined })
  })

  it('preserves repeated prompts with separate IDs and handles empty history', () => {
    const repeated = [{ id: 'a', prompt: 'same' }, { id: 'b', prompt: 'same' }]
    const last = moveComposerHistory(repeated, undefined, '', 'up')!
    expect(moveComposerHistory(repeated, last.position, last.value, 'up')!.position?.id).toBe('a')
    expect(moveComposerHistory([], undefined, '', 'up')).toBeUndefined()
    expect(moveComposerHistory(messages, undefined, '草稿', 'down')).toBeUndefined()
  })

  it('keeps the cursor anchored when earlier pages or new messages arrive', () => {
    const selected = moveComposerHistory(messages, undefined, '草稿', 'up')!
    const expanded = [{ id: 'older', prompt: '更早' }, ...messages, { id: 'new', prompt: '新消息' }]
    expect(moveComposerHistory(expanded, selected.position, selected.value, 'up')!.value).toBe('第一条\n多行')
    expect(moveComposerHistory(expanded, selected.position, selected.value, 'down')!.value).toBe('新消息')
    expect(moveComposerHistory([], selected.position, selected.value, 'up')).toBeUndefined()
  })
})

describe('composer history keyboard integration', () => {
  function setup() {
    let value = '草稿'
    const input = { selectionStart: 0, selectionEnd: 0, setSelectionRange: vi.fn() }
    const textarea = { current: input as unknown as HTMLTextAreaElement }
    const messages = [{ id: 'a', prompt: 'older' }, { id: 'b', prompt: 'latest' }]
    function Render(session = 'one') {
      return useComposerHistory(session, messages, value, (next) => { value = next }, textarea)
    }
    function render(session = 'one') {
      hooks.index = 0
      hooks.layouts = []
      const browser = Render(session)
      hooks.layouts.forEach((effect) => effect())
      return browser
    }
    function key(key: string, overrides = {}) {
      return { key, currentTarget: input, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), ...overrides } as unknown as KeyboardEvent<HTMLTextAreaElement>
    }
    return { input, render, key, value: () => value, setValue: (next: string) => { value = next } }
  }

  it('guards composition, modifiers, selections and ordinary cursor movement', () => {
    const context = setup()
    const browser = context.render()
    for (const overrides of [{ nativeEvent: { isComposing: true } }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
      const event = context.key('ArrowUp', overrides)
      expect(browser.onKeyDown(event)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    context.input.selectionEnd = 1
    expect(browser.onKeyDown(context.key('ArrowUp'))).toBe(false)
    context.input.selectionStart = context.input.selectionEnd = 1
    expect(browser.onKeyDown(context.key('ArrowUp'))).toBe(false)
    expect(browser.onKeyDown(context.key('ArrowDown'))).toBe(false)
    expect(context.value()).toBe('草稿')
  })

  it('recalls messages, places the caret at the end, and restores the draft', () => {
    const context = setup()
    expect(context.render().onKeyDown(context.key('ArrowUp'))).toBe(true)
    expect(context.value()).toBe('latest')
    const browser = context.render()
    expect(context.input.setSelectionRange).toHaveBeenLastCalledWith(6, 6)
    context.input.selectionStart = context.input.selectionEnd = 6
    expect(browser.onKeyDown(context.key('ArrowUp'))).toBe(true)
    expect(context.value()).toBe('older')
    let next = context.render()
    context.input.selectionStart = context.input.selectionEnd = 5
    next.onKeyDown(context.key('ArrowDown'))
    next = context.render()
    context.input.selectionStart = context.input.selectionEnd = 6
    next.onKeyDown(context.key('ArrowDown'))
    expect(context.value()).toBe('草稿')
  })

  it('resets browsing after editing, sending, or switching away and back', () => {
    const context = setup()
    context.render().onKeyDown(context.key('ArrowUp'))
    context.render('two')
    let browser = context.render('one')
    context.input.selectionStart = context.input.selectionEnd = context.value().length
    expect(browser.onKeyDown(context.key('ArrowDown'))).toBe(false)
    context.input.selectionStart = context.input.selectionEnd = 0
    browser.onKeyDown(context.key('ArrowUp'))
    browser = context.render()
    browser.reset()
    context.setValue('edited')
    browser = context.render()
    context.input.selectionStart = context.input.selectionEnd = 6
    expect(browser.onKeyDown(context.key('ArrowDown'))).toBe(false)
    context.setValue('')
    browser = context.render()
    context.input.selectionStart = context.input.selectionEnd = 0
    browser.onKeyDown(context.key('ArrowUp'))
    browser = context.render()
    context.input.selectionStart = context.input.selectionEnd = 6
    browser.onKeyDown(context.key('ArrowDown'))
    expect(context.value()).toBe('')
  })
})
