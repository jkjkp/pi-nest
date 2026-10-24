// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionNavigation } from './session-navigation.js'
import { useWorkspaceStore } from './workspace-store.js'

const sessions = [
  { id: 'root', name: '登录接口排查', cwd: '/fixture' },
  { id: 'a', name: '方案 A', cwd: '/fixture', parentSessionId: 'root' },
  { id: 'b', name: '方案 B', cwd: '/fixture', parentSessionId: 'root' },
  { id: 'child', name: '另一种尝试', cwd: '/fixture', parentSessionId: 'b' },
]
const project = { key: 'cwd:/fixture', name: 'Fixture', cwd: '/fixture', sessions }
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.unstubAllGlobals() })

async function mount(overrides: Partial<ComponentProps<typeof SessionNavigation>> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useWorkspaceStore.setState({ navigationView: 'tree', collapsedSessionIds: {}, sessionNotifications: {}, drafts: { child: '保留草稿' } })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let props: ComponentProps<typeof SessionNavigation> = {
    collapsedProjectKeys: { [project.key]: false }, error: null, isLoading: false, mutationSessionId: undefined,
    onDelete: vi.fn(async () => {}), onSelect: vi.fn(), onRename: vi.fn(async () => {}), onProjectOrderChange: vi.fn(),
    onNewConversation: vi.fn(), onAddProject: vi.fn(), onRemoveProject: vi.fn(), onRevealProject: vi.fn(async () => {}),
    onSessionOrderChange: vi.fn(), onToggleProject: vi.fn(), projects: [project], runs: {}, selectedSessionId: 'child', ...overrides,
  }
  const render = async (next: Partial<typeof props>) => { props = { ...props, ...next }; await act(() => root.render(<SessionNavigation {...props} />)) }
  cleanup = async () => { await act(async () => { root.unmount(); await new Promise((done) => setTimeout(done, 0)) }); container.remove() }
  await render({})
  const click = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
    expect(button, label).not.toBeNull()
    await act(() => button!.click())
  }
  const ids = () => [...container.querySelectorAll('[data-session-id]')].map((node) => node.getAttribute('data-session-id'))
  return { container, click, ids, render, props }
}

it('reveals the selected lineage, keeps toggles separate from selection, and preserves drafts when switching views', async () => {
  const ui = await mount()
  expect(ui.ids()).toEqual(['root', 'a', 'b', 'child'])
  expect(ui.container.querySelector('[data-session-id="child"]')?.getAttribute('data-depth')).toBe('2')
  await ui.click('折叠 方案 B 的分支')
  expect(ui.ids()).toEqual(['root', 'a', 'b'])
  expect(ui.props.onSelect).not.toHaveBeenCalled()
  await ui.click('列表视图')
  expect(ui.container.textContent).toContain('另一种尝试')
  expect(ui.container.querySelector('[aria-current="page"]')?.textContent).toContain('另一种尝试')
  await ui.click('树状视图')
  expect(ui.ids()).toContain('child')
  expect(useWorkspaceStore.getState().drafts.child).toBe('保留草稿')
  const title = ui.container.querySelector<HTMLButtonElement>('[data-session-id="b"] button[aria-describedby]')
  expect(title).not.toBeNull()
  await act(() => title!.click())
  expect(ui.props.onSelect).toHaveBeenCalledWith('b')
})

it('temporarily expands matching lineage during search and restores manual collapse afterward', async () => {
  const ui = await mount()
  await ui.click('折叠 登录接口排查 的分支')
  const input = ui.container.querySelector<HTMLInputElement>('#session-search')!
  const search = async (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await search('另一种')
  expect(ui.ids()).toEqual(['root', 'b', 'child'])
  await search('')
  expect(ui.ids()).toEqual(['root'])
  expect(useWorkspaceStore.getState().collapsedSessionIds.root).toBe(true)
})

it('summarizes hidden descendant status and promotes children when a parent disappears', async () => {
  const ui = await mount({ selectedSessionId: 'root', runs: { child: { status: 'error', pendingInputs: [], systemEvents: [], turns: [] } } })
  await act(() => useWorkspaceStore.setState({ sessionNotifications: { a: { pendingRunId: 'run' }, child: { completedRunId: 'done' } } }))
  expect(ui.ids()).toEqual(['root'])
  expect(ui.container.querySelector('[role="status"]')?.textContent).toBe('1 运行中 · 1 失败 · 1 未读')
  await ui.render({ projects: [{ ...project, sessions: sessions.filter((session) => session.id !== 'root') }] })
  expect(ui.ids()).toEqual(['a', 'b'])
  expect(ui.container.querySelectorAll('[aria-label="来源会话不可用"]')).toHaveLength(2)
  await ui.click('展开 方案 B 的分支')
  expect(ui.ids()).toEqual(['a', 'b', 'child'])
})

it('immediately attaches and reveals a newly created branch', async () => {
  const ui = await mount({ selectedSessionId: 'root' })
  await ui.render({ projects: [{ ...project, sessions: [...sessions, { id: 'new', name: '新分支', cwd: '/fixture', parentSessionId: 'child' }] }], selectedSessionId: 'new' })
  expect(ui.ids()).toEqual(['root', 'a', 'b', 'child', 'new'])
  expect(ui.container.querySelector('[aria-current="page"]')?.textContent).toContain('新分支')
})
