import { beforeEach, expect, it, vi } from 'vitest'
import type { ComponentProps, ReactElement } from 'react'
import type { PiRuntimeCommand } from '@pi-nest/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { Textarea } from '@/components/ui/textarea'
import { CommandComposer } from './command-composer.js'
import type { SessionRunController } from './session-run-controller.js'

const hooks = vi.hoisted(() => ({ slots: [] as any[], index: 0, layouts: [] as (() => void)[] }))
const query = vi.hoisted(() => ({ data: [{ name: 'plan', description: 'Plan work', source: 'extension' }] as PiRuntimeCommand[] | undefined, isError: false, isFetching: false, refetch: vi.fn(), options: {} as any }))
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useId: () => 'commands',
  useRef: (initial: unknown) => { const index = hooks.index++; return hooks.slots[index] ?? (hooks.slots[index] = { current: initial }) },
  useState: (initial: unknown) => {
    const index = hooks.index++
    if (!(index in hooks.slots)) hooks.slots[index] = initial
    return [hooks.slots[index], (next: any) => { hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next }]
  },
  useEffect: () => undefined,
  useLayoutEffect: (effect: () => void) => hooks.layouts.push(effect),
}))
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => { query.options = options; return query } }))

beforeEach(() => { hooks.slots = []; hooks.index = 0; hooks.layouts = []; query.isError = false; query.isFetching = false; query.data = [{ name: 'plan', description: 'Plan work', source: 'extension' }]; query.refetch.mockClear() })

function setup(initial = '/pl', sessionId = 'one', canQuery = true) {
  let value = initial
  const input = { value, selectionStart: value.length, selectionEnd: value.length, focus: vi.fn(), setSelectionRange: vi.fn() }
  const downstream = vi.fn()
  const execute = vi.fn()
  const sessionRuns = { getCommands: vi.fn(async () => query.data) } as unknown as SessionRunController
  let element: ReactElement<{ children: ReactElement[] }>
  function render() {
    hooks.index = 0
    hooks.layouts = []
    input.value = value
    element = CommandComposer({ value, sessionId, canQuery, sessionRuns, textareaRef: { current: input as unknown as HTMLTextAreaElement }, onValueChange: (next) => { value = next }, onExecuteCommand: execute, onKeyDown: downstream }) as typeof element
    hooks.layouts.forEach((effect) => effect())
    return element
  }
  function textarea() { return (element.props.children[1] as ReactElement<ComponentProps<typeof Textarea>>).props }
  function key(key: string, overrides = {}) {
    const event = { key, currentTarget: input, nativeEvent: { isComposing: false }, preventDefault: vi.fn(), ...overrides }
    textarea().onKeyDown!(event as never)
    return event
  }
  render()
  textarea().onFocus!({ currentTarget: input } as never)
  render()
  return { render, textarea, key, input, downstream, execute, sessionRuns, value: () => value }
}

it.each(['/cl', '/clo', '/clon', '/clone', ' /cl'])('executes the selected clone on one Enter for %s', (value) => {
  const context = setup(value)
  context.execute.mockImplementation((text) => { expect(context.value()).toBe(text) })
  expect(context.key('Enter').preventDefault).toHaveBeenCalledOnce()
  expect(context.execute).toHaveBeenCalledExactlyOnceWith(value.startsWith(' ') ? ' /clone ' : '/clone ')
  expect(context.downstream).not.toHaveBeenCalled()
})

it.each([
  ['/cl', 'Tab'], ['你好 /cl', 'Enter'], ['/clone 参数', 'Enter'], ['/model', 'Enter'],
])('only completes %s with %s', (value, key) => {
  const context = setup(value)
  if (value === '/clone 参数') {
    context.input.selectionStart = context.input.selectionEnd = 6
    context.textarea().onSelect!({ currentTarget: context.input } as never)
    context.render()
  }
  expect(context.key(key).preventDefault).toHaveBeenCalledOnce()
  expect(context.execute).not.toHaveBeenCalled()
  expect(context.downstream).not.toHaveBeenCalled()
})

it('does not execute clone while confirming IME input', () => {
  const context = setup('/cl')
  context.key('Enter', { nativeEvent: { isComposing: true } })
  expect(context.execute).not.toHaveBeenCalled()
  expect(context.value()).toBe('/cl')
})

it('completes with Enter or Tab, preserves surrounding text and never sends', () => {
  for (const key of ['Enter', 'Tab']) {
    hooks.slots = []
    const context = setup('你好 /pl 后续')
    context.input.selectionStart = context.input.selectionEnd = 6
    context.textarea().onSelect!({ currentTarget: context.input } as never)
    context.render()
    expect(query.options.enabled).toBe(true)
    expect(context.key(key).preventDefault).toHaveBeenCalled()
    context.render()
    expect(context.value()).toBe('你好 /plan 后续')
    expect(context.input.setSelectionRange).toHaveBeenCalledWith(9, 9)
    expect(context.textarea()['aria-controls']).toBeUndefined()
    expect(context.downstream).not.toHaveBeenCalled()
    context.key('Enter')
    expect(context.downstream).toHaveBeenCalledOnce()
  }
})

it('reserves arrows for suggestions, dismisses with Escape and allows modified shortcuts', () => {
  const context = setup('/')
  expect(context.textarea()['aria-activedescendant']).toBe('commands-0')
  context.key('ArrowDown')
  context.render()
  expect(context.textarea()['aria-activedescendant']).toBe('commands-1')
  context.key('ArrowUp')
  context.render()
  expect(context.textarea()['aria-activedescendant']).toBe('commands-0')
  expect(context.downstream).not.toHaveBeenCalled()
  context.key('Enter', { shiftKey: true })
  expect(context.downstream).toHaveBeenCalledOnce()
  context.key('Escape')
  context.render()
  expect(context.textarea()['aria-controls']).toBeUndefined()
  expect(context.value()).toBe('/')
  context.key('ArrowUp')
  expect(context.downstream).toHaveBeenCalledTimes(2)
})

it('does not select or send during IME composition', () => {
  const context = setup()
  context.key('Enter', { nativeEvent: { isComposing: true } })
  context.key('Enter', { nativeEvent: { keyCode: 229 } })
  context.textarea().onCompositionStart!({} as never)
  context.render()
  expect(context.textarea()['aria-controls']).toBeUndefined()
  context.key('Enter')
  expect(context.downstream).not.toHaveBeenCalled()
  expect(context.value()).toBe('/pl')
})

it('uses cached suggestions while busy, isolates session queries and does not load a draft runtime', () => {
  const context = setup('/pl', 'two', false)
  expect(query.options.queryKey).toEqual(['runtime-commands', 'two'])
  expect(query.options.enabled).toBe(false)
  expect(renderToStaticMarkup(context.render())).toContain('/plan')
  hooks.slots = []
  const draft = setup('/pl', '', true)
  expect(query.options.enabled).toBe(false)
  expect(draft.textarea()['aria-controls']).toBeUndefined()
})

it('keeps failed queries retryable without clearing input and closes on blur', () => {
  query.isError = true
  const context = setup()
  expect(renderToStaticMarkup(context.render())).toContain('命令列表加载失败')
  expect(context.value()).toBe('/pl')
  const popup = context.render().props.children[0] as ReactElement<any>
  popup.props.children[1].props.children[1].props.onClick()
  expect(query.refetch).toHaveBeenCalledOnce()
  ;(context.render().props as any).onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} })
  expect(context.textarea()['aria-controls']).toBe('commands')
  ;(context.render().props as any).onBlur({ currentTarget: { contains: () => false }, relatedTarget: null })
  context.render()
  expect(context.textarea()['aria-controls']).toBeUndefined()
})

it('supports clicking a suggestion without submitting the input', () => {
  const context = setup('你好 /pl')
  const popup = context.render().props.children[0] as ReactElement<any>
  const option = popup.props.children[0].props.children[0][0]
  const event = { preventDefault: vi.fn() }
  option.props.onMouseDown(event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  option.props.onClick()
  context.render()
  expect(context.value()).toBe('你好 /plan ')
  expect(context.downstream).not.toHaveBeenCalled()
})

it.each(['/p', '/pl', '/pla', '/plan'])('shows plan suggestions for the prefix %s', (value) => {
  const context = setup(value)
  expect(query.options.enabled).toBe(true)
  expect(context.textarea()['aria-controls']).toBe('commands')
  expect(renderToStaticMarkup(context.render())).toContain('/plan')
})

it('does not claim no match before the native commands are available', () => {
  query.data = undefined
  const context = setup('/p', 'one', false)
  let markup = renderToStaticMarkup(context.render())
  expect(markup).not.toContain('没有匹配的命令')
  expect(markup).toContain('会话空闲且运行时就绪后可读取更多命令')
  query.isFetching = true
  markup = renderToStaticMarkup(context.render())
  expect(markup).not.toContain('没有匹配的命令')
  expect(markup).toContain('正在读取命令')
})
