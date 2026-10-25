// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AnswerActions } from './answer-actions.js'
import { SessionTimeline } from './session-timeline.js'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function button(label: string) { return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)! }

it('copies the original reply with borderless icons matching the text size', async () => {
  const writeText = vi.fn(async () => {})
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard)
  await act(() => root.render(<AnswerActions text={'**原文**\n第二段'} onBranch={vi.fn(async () => {})} />))
  expect(button('复制回复').classList.contains('border-0')).toBe(true)
  expect(button('分支到聊天').classList.contains('border-0')).toBe(true)
  expect(button('复制回复').querySelector('svg')?.classList.contains('size-[1em]')).toBe(true)
  const icon = button('复制回复').querySelector('svg')!.outerHTML
  await act(async () => button('复制回复').click())
  expect(writeText).toHaveBeenCalledExactlyOnceWith('**原文**\n第二段')
  expect(button('复制回复').querySelector('svg')!.outerHTML).toBe(icon)
  expect(button('复制回复').title).toBe('复制回复')
  expect(button('已复制')).toBeNull()
  await act(async () => button('复制回复').click())
  expect(writeText).toHaveBeenCalledTimes(2)
})

it.each([true, false])('shows a one-second toast on copy failure without inline text (clipboard available: %s)', async (available) => {
  vi.useFakeTimers()
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue((available ? { writeText: vi.fn(async () => { throw new Error('denied') }) } : undefined) as unknown as Clipboard)
  await act(() => root.render(<AnswerActions text="answer" />))
  expect(button('分支到聊天').disabled).toBe(true)
  await act(async () => button('复制回复').click())
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('复制失败')
  await act(() => vi.advanceTimersByTime(999))
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  await act(() => vi.advanceTimersByTime(1))
  expect(document.querySelector('[role="alert"]')).toBeNull()
})


it('restarts the toast duration on another copy failure and removes it on unmount', async () => {
  vi.useFakeTimers()
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText: vi.fn(async () => { throw new Error('denied') }) } as unknown as Clipboard)
  await act(() => root.render(<AnswerActions text="answer" />))
  await act(async () => button('复制回复').click())
  await act(() => vi.advanceTimersByTime(800))
  await act(async () => button('复制回复').click())
  await act(() => vi.advanceTimersByTime(800))
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('复制失败')
  await act(() => root.render(null))
  expect(document.querySelector('[role="alert"]')).toBeNull()
  await act(() => vi.advanceTimersByTime(1000))
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

it('prevents duplicate branches, shows a one-second failure toast, and allows retry', async () => {
  vi.useFakeTimers()
  let reject!: (cause: Error) => void
  const onBranch = vi.fn<() => Promise<void>>().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValue(undefined)
  await act(() => root.render(<AnswerActions text="answer" onBranch={onBranch} />))
  await act(() => { button('分支到聊天').click(); button('分支到聊天').click() })
  expect(onBranch).toHaveBeenCalledTimes(1)
  expect(button('分支到聊天').disabled).toBe(true)
  await act(async () => reject(new Error('历史已变化，请刷新')))
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('分支失败')
  await act(() => vi.advanceTimersByTime(999))
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  await act(() => vi.advanceTimersByTime(1))
  expect(document.querySelector('[role="alert"]')).toBeNull()
  await act(async () => button('分支到聊天').click())
  expect(onBranch).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('branches from the displayed persisted assistant entry and hides actions while streaming', async () => {
  const history = { revision: 'a'.repeat(64), session: { id: 'source' }, hasEarlier: false, entries: [
    { id: 'user', parentId: null, type: 'message', timestamp: '2026-10-25T00:00:00Z', raw: { type: 'message', message: { role: 'user', content: 'question' } } },
    { id: 'answer', parentId: 'user', type: 'message', timestamp: '2026-10-25T00:00:01Z', raw: { type: 'message', message: { role: 'assistant', content: 'reply', stopReason: 'stop' } } },
  ] }
  const onBranchAnswer = vi.fn(async () => {})
  const props = { error: false, isLoading: false, history, onRetry: vi.fn(), onBranchAnswer }
  await act(() => root.render(<SessionTimeline {...props} />))
  await act(async () => button('分支到聊天').click())
  expect(onBranchAnswer).toHaveBeenCalledExactlyOnceWith('answer', history.revision)
  await act(() => root.render(<SessionTimeline {...props} branchDisabled />))
  expect(button('分支到聊天').disabled).toBe(true)
  await act(() => root.render(<SessionTimeline {...props} isRunning />))
  expect(container.querySelector('[aria-label="回复操作"]')).toBeNull()
})
