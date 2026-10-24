// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SessionNavigation } from './session-navigation.js'
import { useWorkspaceStore } from './workspace-store.js'

it.each(['list', 'tree'] as const)('clones the right-clicked session and displays failures in %s view', async (navigationView) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useWorkspaceStore.setState({ navigationView, collapsedSessionIds: {}, sessionNotifications: {} })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onClone = vi.fn(async () => { throw new Error('克隆失败，请重试') })
  const onSelect = vi.fn()
  const props: ComponentProps<typeof SessionNavigation> = {
    collapsedProjectKeys: {}, error: null, isLoading: false, mutationSessionId: undefined,
    onClone, onSelect, onDelete: vi.fn(async () => {}), onRename: vi.fn(async () => {}),
    onProjectOrderChange: vi.fn(), onNewConversation: vi.fn(), onAddProject: vi.fn(),
    onRemoveProject: vi.fn(), onRevealProject: vi.fn(async () => {}), onSessionOrderChange: vi.fn(), onToggleProject: vi.fn(),
    projects: [{ key: 'cwd:/fixture', cwd: '/fixture', name: 'Fixture', sessions: [{ id: 'one', name: '当前对话' }, { id: 'two', name: '另一会话' }] }],
    selectedSessionId: 'one', runs: {},
  }
  async function open() {
    const row = container.querySelector('[aria-label="删除 另一会话"]')!.parentElement!
    await act(() => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === '克隆对话')!
  }
  try {
    await act(() => root.render(<SessionNavigation {...props} />))
    await act(async () => (await open()).click())
    expect(onClone).toHaveBeenCalledExactlyOnceWith('two')
    expect(onSelect).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('克隆失败，请重试')
    const blockedStates: Partial<ComponentProps<typeof SessionNavigation>>[] = [
      { mutationSessionId: 'two', runs: {} },
      { mutationSessionId: undefined, runs: { two: { status: 'running' as const, turns: [], systemEvents: [], pendingInputs: [] } } },
    ]
    for (const next of blockedStates) {
      await act(() => root.render(<SessionNavigation {...props} {...next} />))
      const item = await open()
      expect(item.getAttribute('data-disabled')).not.toBeNull()
      await act(() => item.click())
      expect(onClone).toHaveBeenCalledTimes(1)
      await act(() => item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    }
  } finally {
    await act(async () => { root.unmount(); await new Promise((done) => setTimeout(done, 0)) })
    container.remove()
    vi.unstubAllGlobals()
  }
})
