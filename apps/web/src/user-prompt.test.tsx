// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionTimeline } from './session-timeline.js'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function renderPrompt(prompt = '第一行\n**原始文字**') {
  const history = { revision: 'fixture', session: { id: 'source' }, hasEarlier: false, entries: [
    { id: 'user', parentId: null, type: 'message', timestamp: '2026-10-25T00:00:00Z', raw: { type: 'message', message: { role: 'user', content: prompt } } },
  ] }
  await act(() => root.render(<SessionTimeline error={false} isLoading={false} history={history} onRetry={() => {}} />))
}
function copyButton() { return container.querySelector<HTMLButtonElement>('[aria-label="复制消息"]')! }

it('copies the full collapsed prompt and resets its borderless success icon', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(224)
  const writeText = vi.fn(async () => {})
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard)
  await renderPrompt()
  expect(container.textContent).toContain('显示更多')
  expect(container.textContent).not.toContain('用户 ·')
  expect(container.querySelector('time')?.dateTime).toBe('2026-10-25T00:00:00Z')
  expect(copyButton().classList.contains('border-0')).toBe(true)
  expect(copyButton().querySelector('svg')?.classList.contains('size-[1em]')).toBe(true)
  vi.useFakeTimers()
  await act(async () => copyButton().click())
  expect(writeText).toHaveBeenCalledExactlyOnceWith('第一行\n**原始文字**')
  expect(container.querySelector('[aria-label="已复制"]')).not.toBeNull()
  await act(() => vi.advanceTimersByTime(2000))
  expect(copyButton()).not.toBeNull()
  const expand = [...container.querySelectorAll('button')].find((button) => button.textContent === '显示更多')!
  await act(() => expand.click())
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  expect(expand.textContent).toBe('收起')
})

it('reports denied or missing clipboard access and allows retry', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
  const clipboard = vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard)
  await renderPrompt()
  await act(async () => copyButton().click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('剪贴板权限')
  await act(async () => copyButton().click())
  expect(container.querySelector('[role="alert"]')).toBeNull()
  clipboard.mockReturnValue(undefined as unknown as Clipboard)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="已复制"]')!.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('不支持剪贴板')
})

it('toggles touch actions without hiding them when tapping copy', async () => {
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText: vi.fn(async () => {}) } as unknown as Clipboard)
  await renderPrompt()
  const bubble = container.querySelector<HTMLElement>('.user-prompt')!
  const tap = (node: Element) => act(() => { node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })) })
  expect(bubble.dataset.touchRevealed).toBe('false')
  await tap(bubble.querySelector('pre')!)
  expect(bubble.dataset.touchRevealed).toBe('true')
  await tap(copyButton().querySelector('svg')!)
  expect(bubble.dataset.touchRevealed).toBe('true')
  await tap(bubble)
  expect(bubble.dataset.touchRevealed).toBe('false')
})

it('offers a borderless pencil beside copy only on the last user bubble and edits its native entry', async () => {
  const onEditLast = vi.fn()
  const entries = ['older', 'latest'].map((id, index) => ({ id, parentId: index ? 'older' : null, type: 'message', timestamp: '2026-11-02T00:00:00Z', raw: { message: { role: 'user', content: id } } }))
  const history = { revision: 'fixture', session: { id: 'source' }, hasEarlier: false, entries }
  const render = (editDisabled = false) => act(() => root.render(<SessionTimeline error={false} isLoading={false} history={history} onRetry={() => {}} onEditLast={onEditLast} editDisabled={editDisabled} />))
  await render()
  const button = container.querySelector<HTMLButtonElement>('[aria-label="编辑最后一条用户消息"]')!
  expect(container.querySelectorAll('[aria-label="编辑最后一条用户消息"]')).toHaveLength(1)
  expect(button.closest('[data-turn-id]')?.getAttribute('data-turn-id')).toBe('latest')
  expect(button.closest('.user-prompt-actions')).not.toBeNull()
  expect(button.previousElementSibling?.getAttribute('aria-label')).toBe('复制消息')
  expect(button.closest('.user-prompt')?.getAttribute('data-editable')).toBe('true')
  expect(button.classList.contains('border-0')).toBe(true)
  expect(button.querySelector('svg')).not.toBeNull()
  expect(button.title).toBe('编辑消息')
  await act(() => button.click())
  expect(onEditLast).toHaveBeenCalledExactlyOnceWith('latest')
  await render(true)
  expect(button.disabled).toBe(true)
  await act(() => button.click())
  expect(onEditLast).toHaveBeenCalledOnce()
})

it('keeps the edit entry available for the last attachment-only user message', async () => {
  const onEditLast = vi.fn()
  const history = { revision: 'fixture', session: { id: 'source' }, hasEarlier: false, entries: [
    { id: 'image-user', parentId: null, type: 'message', timestamp: '2026-11-02T00:00:00Z', raw: { message: { role: 'user', content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] } } },
  ] }
  await act(() => root.render(<SessionTimeline error={false} isLoading={false} history={history} onRetry={() => {}} onEditLast={onEditLast} />))
  expect(container.querySelector('.user-prompt pre')).toBeNull()
  expect(copyButton()).toBeNull()
  const button = container.querySelector<HTMLButtonElement>('[aria-label="编辑最后一条用户消息"]')!
  await act(() => button.click())
  expect(onEditLast).toHaveBeenCalledExactlyOnceWith('image-user')
})

it('replaces the source bubble in place and preserves the editor when a history change removes its source', async () => {
  const history = { revision: 'fixture', session: { id: 'source' }, hasEarlier: false, entries: [
    { id: 'user', parentId: null, type: 'message', timestamp: '2026-11-02T00:00:00Z', raw: { message: { role: 'user', content: 'original bubble' } } },
    { id: 'answer', parentId: 'user', type: 'message', timestamp: '2026-11-02T00:00:01Z', raw: { type: 'message', message: { role: 'assistant', content: 'original answer', stopReason: 'stop' } } },
  ] }
  const messageEdit = { entryId: 'user', editor: <section aria-label="编辑用户消息"><textarea defaultValue="editing text" /></section> }
  await act(() => root.render(<SessionTimeline error={false} isLoading={false} history={history} onRetry={() => {}} messageEdit={messageEdit} />))
  const editor = container.querySelector('[aria-label="编辑用户消息"]')!
  expect(editor.closest('[data-turn-id]')?.getAttribute('data-turn-id')).toBe('user')
  expect(container.querySelector('.user-prompt')).toBeNull()
  expect(container.textContent).toContain('original answer')
  await act(() => root.render(<SessionTimeline error={false} isLoading history={{ ...history, entries: [] }} onRetry={() => {}} messageEdit={messageEdit} />))
  expect(container.querySelector('textarea')?.value).toBe('editing text')
})


it('keeps the prompt toggle transparent in both states with a small directional chevron', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(224)
  await renderPrompt()
  const toggle = container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!
  const transparent = () => {
    for (const style of ['border-0', 'bg-transparent', 'hover:bg-transparent', 'dark:hover:bg-transparent', 'aria-expanded:bg-transparent', 'aria-expanded:text-inherit']) {
      expect(toggle.classList.contains(style)).toBe(true)
    }
    expect(toggle.querySelector('span')?.classList.contains('text-xs')).toBe(true)
    expect(toggle.querySelector('svg')?.classList.contains('size-[1em]')).toBe(true)
  }
  transparent()
  expect(toggle.textContent).toBe('显示更多')
  expect(toggle.querySelector('svg')?.classList.contains('rotate-180')).toBe(false)
  expect(container.querySelector('.bg-gradient-to-t')).not.toBeNull()
  await act(() => toggle.click())
  transparent()
  expect(toggle.textContent).toBe('收起')
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(toggle.querySelector('svg')?.classList.contains('rotate-180')).toBe(true)
  expect(container.querySelector('.bg-gradient-to-t')).toBeNull()
  await act(() => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.textContent).toBe('显示更多')
  expect(container.querySelector('.bg-gradient-to-t')).not.toBeNull()
})

it('creates an independent edit branch on any native user message without invoking same-file editing', async () => {
  const onBranchUser = vi.fn().mockRejectedValueOnce(new Error('关系存储不可用')).mockResolvedValue(undefined)
  const onEditLast = vi.fn()
  const entries = ['older', 'latest'].map((id, index) => ({ id, parentId: index ? 'older' : null, type: 'message', timestamp: '2026-11-03T00:00:00Z', raw: { message: { role: 'user', content: id } } }))
  const history = { revision: 'branch-revision', session: { id: 'source' }, hasEarlier: false, entries }
  const render = (branchDisabled = false) => act(() => root.render(<SessionTimeline error={false} isLoading={false} history={history} onRetry={() => {}} onEditLast={onEditLast} onBranchUser={onBranchUser} branchDisabled={branchDisabled} />))
  await render()
  const buttons = container.querySelectorAll<HTMLButtonElement>('[aria-label="修改此轮新建分支"]')
  expect(buttons).toHaveLength(2)
  await act(async () => buttons[0].click())
  expect(onBranchUser).toHaveBeenCalledExactlyOnceWith('older', 'branch-revision')
  expect(onEditLast).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('关系存储不可用')
  await act(async () => buttons[0].click())
  expect(container.querySelector('[role="alert"]')).toBeNull()
  await render(true)
  expect(container.querySelector('[aria-label="修改此轮新建分支"]')).toBeNull()
  expect(container.querySelectorAll('[aria-label="编辑最后一条用户消息"]')).toHaveLength(1)
})
