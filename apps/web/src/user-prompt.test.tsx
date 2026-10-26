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
