// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SessionNavigation } from './session-navigation.js'

it.each([undefined, '没有访问项目文件夹的权限。'])('opens the selected project folder and displays actionable failures (%s)', async (failure) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const openFolder = vi.fn(async () => { if (failure) throw new Error(failure) })
  try {
    await act(() => root.render(<SessionNavigation
      collapsedProjectKeys={{}} error={null} isLoading={false} mutationSessionId={undefined}
      onClone={vi.fn(async () => {})} onDelete={vi.fn(async () => {})} onSelect={vi.fn()} onRename={vi.fn(async () => {})}
      onProjectOrderChange={vi.fn()} onNewConversation={vi.fn()} onAddProject={vi.fn()}
      onRemoveProject={vi.fn()} onRevealProject={openFolder} onSessionOrderChange={vi.fn()}
      onToggleProject={vi.fn()} projects={[{ key: 'cwd:/fixture', cwd: '/fixture', name: 'Fixture', sessions: [] }]} selectedSessionId="" runs={{}}
    />))
    const more = container.querySelector<HTMLButtonElement>('[aria-label="Fixture 更多操作"]')!
    await act(() => more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })))
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === '打开项目文件夹')!
    expect(item).toBeDefined()
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Finder')
    await act(async () => item.click())
    expect(openFolder).toHaveBeenCalledExactlyOnceWith('/fixture')
    if (failure) expect(container.textContent).toContain(failure)
  } finally {
    await act(async () => { root.unmount(); await new Promise((done) => setTimeout(done, 0)) })
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('limits borderless project actions to header hover/focus and keeps an open menu usable', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const matchMedia = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const media = matchMedia(query)
    if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(media, 'matches', { value: true })
    return media
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onNewConversation = vi.fn()
  const onToggleProject = vi.fn()
  const project = { key: 'cwd:/fixture', cwd: '/fixture', name: 'Fixture', sessions: [{ id: 'one', name: '当前对话' }] }
  try {
    await act(() => root.render(<SessionNavigation
      collapsedProjectKeys={{}} error={null} isLoading={false} mutationSessionId={undefined}
      onClone={vi.fn(async () => {})} onDelete={vi.fn(async () => {})} onSelect={vi.fn()} onRename={vi.fn(async () => {})}
      onProjectOrderChange={vi.fn()} onNewConversation={onNewConversation} onAddProject={vi.fn()}
      onRemoveProject={vi.fn()} onRevealProject={vi.fn(async () => {})} onSessionOrderChange={vi.fn()}
      onToggleProject={onToggleProject} projects={[project]} selectedSessionId="one" runs={{}}
    />))
    const more = container.querySelector<HTMLButtonElement>('[aria-label="Fixture 更多操作"]')!
    const create = container.querySelector<HTMLButtonElement>('[aria-label="在 Fixture 新建对话"]')!
    const headerButton = container.querySelector<HTMLButtonElement>('[aria-controls^="project-sessions-"]')!
    const header = headerButton.parentElement!
    const sessions = container.querySelector<HTMLElement>(`[id="${headerButton.getAttribute('aria-controls')}"]`)!
    const session = sessions.querySelector<HTMLButtonElement>('button')!
    const hidden = (expected: boolean) => {
      for (const button of [more, create]) {
        expect(button.classList.contains('opacity-0')).toBe(expected)
        expect(button.classList.contains('pointer-events-none')).toBe(expected)
        expect(button.classList.contains('border-0')).toBe(true)
      }
    }
    hidden(true)
    await act(() => { session.focus(); session.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })) })
    hidden(true)
    await act(() => session.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: header })))
    hidden(false)
    await act(() => header.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: session })))
    hidden(true)
    await act(() => headerButton.focus())
    hidden(false)
    await act(() => create.focus())
    hidden(false)
    await act(() => create.click())
    expect(onNewConversation).toHaveBeenCalledExactlyOnceWith(project)
    expect(onToggleProject).not.toHaveBeenCalled()
    await act(() => session.focus())
    hidden(true)
    await act(() => more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })))
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    hidden(false)
    await act(async () => {
      document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
    await act(() => session.focus())
    hidden(true)
  } finally {
    await act(async () => { root.unmount(); await new Promise((done) => setTimeout(done, 0)) })
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
