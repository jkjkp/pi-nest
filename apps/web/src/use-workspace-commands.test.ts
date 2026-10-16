import { fetchSessionTurnIndex } from './workspace-api.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspaceCommands } from './use-workspace-commands.js'
import { useWorkspaceStore } from './workspace-store.js'
import type { useWorkspaceSession } from './use-workspace-session.js'
import type { SessionRunController } from './session-run-controller.js'

vi.mock('./workspace-api.js', () => ({ fetchSessionTurnIndex: vi.fn() }))

const hooks = vi.hoisted(() => ({ slots: [] as any[], index: 0, layouts: [] as (() => void)[] }))
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: (initial: unknown) => { const index = hooks.index++; return hooks.slots[index] ?? (hooks.slots[index] = { current: initial }) },
  useState: (initial: unknown) => {
    const index = hooks.index++
    if (!(index in hooks.slots)) hooks.slots[index] = initial
    return [hooks.slots[index], (next: any) => { hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next }]
  },
  useLayoutEffect: (effect: () => void) => hooks.layouts.push(effect),
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const index = hooks.index++
    const previous = hooks.slots[index]
    if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return
    hooks.layouts.push(() => { previous?.cleanup?.(); hooks.slots[index] = { deps, cleanup: effect() } })
  },
}))
afterEach(() => { for (const slot of hooks.slots) slot?.cleanup?.(); vi.useRealTimers() })
beforeEach(() => { hooks.slots = []; hooks.index = 0; hooks.layouts = []; useWorkspaceStore.setState({ drafts: {} }); vi.unstubAllGlobals(); vi.mocked(fetchSessionTurnIndex).mockReset().mockResolvedValue({ revision: 'a'.repeat(64), entries: [] }) })
async function tick() { for (let index = 0; index < 12; index++) await Promise.resolve() }
function setup(text: string) {
  useWorkspaceStore.getState().setDraft('one', text)
  const workspace = {
    selectedSessionId: 'one', selectedSession: { id: 'one', name: 'Old' }, isDraft: false, isActive: false,
    runtimeStates: { one: { lifecycle: 'idle', revision: 1 } }, modelStatus: 'unloaded', thinkingStatus: 'unloaded', mutatingSessionId: undefined,
    createBranch: vi.fn().mockResolvedValue({ session: { id: 'child', cwd: '/fixture' }, draft: 'selected' }), selectSession: vi.fn(),
    openModels: vi.fn().mockResolvedValue([{ provider: 'fixture', id: 'model/with/slash' }]), changeModel: vi.fn().mockResolvedValue(true), handleRename: vi.fn().mockResolvedValue(undefined),
    historyQuery: { isPending: false, isError: false }, history: { entries: [{ type: 'message', timestamp: '2026-10-16', raw: { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '**Answer**' }] } } }] },
  } as unknown as ReturnType<typeof useWorkspaceSession>
  const sessionRuns = { compact: vi.fn().mockResolvedValue(undefined), getSessionStatistics: vi.fn().mockResolvedValue(undefined) } as unknown as SessionRunController
  const ui = { fork: vi.fn(), model: vi.fn(), rename: vi.fn(), statistics: vi.fn(), settings: vi.fn() }
  function Render() { return useWorkspaceCommands(workspace, sessionRuns, ui) }
  function render() {
    hooks.index = 0; hooks.layouts = []
    const result = Render()
    hooks.layouts.forEach((effect) => effect())
    return result
  }
  return { workspace, sessionRuns, ui, render, submit: () => render().submit(text), draft: () => useWorkspaceStore.getState().drafts.one }
}

it.each([['/model', 'model'], ['/session', 'statistics'], ['/settings', 'settings']] as const)('opens the existing UI for %s without a model prompt', async (text, action) => {
  const context = setup(text)
  expect(context.submit()).toBe(true)
  await tick()
  expect(context.ui[action]).toHaveBeenCalledOnce()
  expect(context.draft()).toBe('')
})
it('matches a full provider/model id including slashes and reports invalid models', async () => {
  const context = setup('/model fixture/model/with/slash')
  context.submit(); await tick()
  expect(context.workspace.changeModel).toHaveBeenCalledWith('fixture', 'model/with/slash')
  expect(context.draft()).toBe('')
  useWorkspaceStore.getState().setDraft('one', '/model missing')
  context.render().submit('/model missing'); await tick()
  expect(context.render().notice?.error).toBe(true)
  expect(context.draft()).toBe('/model missing')
})
it('passes compaction instructions, blocks duplicate commands and preserves new input', async () => {
  const context = setup('/compact 保留接口设计')
  let release!: () => void
  vi.mocked(context.sessionRuns.compact).mockReturnValue(new Promise((resolve) => { release = resolve }))
  context.submit()
  expect(context.render().busy).toBe(true)
  context.submit()
  expect(context.sessionRuns.compact).toHaveBeenCalledOnce()
  expect(context.sessionRuns.compact).toHaveBeenCalledWith('one', '保留接口设计')
  useWorkspaceStore.getState().setDraft('one', '新草稿')
  release(); await tick()
  expect(context.draft()).toBe('新草稿')
  expect(context.render().busy).toBe(false)
})
it('keeps failed commands and does not clear a draft after switching sessions', async () => {
  const context = setup('/compact')
  vi.mocked(context.sessionRuns.compact).mockRejectedValueOnce(new Error('Cannot compact'))
  context.submit(); await tick()
  expect(context.draft()).toBe('/compact')
  expect(context.render().notice?.message).toBe('Cannot compact')
  let release!: () => void
  vi.mocked(context.sessionRuns.compact).mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
  context.submit()
  context.workspace.selectedSessionId = 'two'
  useWorkspaceStore.getState().setDraft('two', '另一会话')
  context.render()
  release(); await tick()
  expect(context.draft()).toBe('/compact')
  expect(useWorkspaceStore.getState().drafts.two).toBe('另一会话')
  expect(context.render().notice).toBeUndefined()
})
it('renames directly or keeps /name until the shared dialog saves', async () => {
  const context = setup('/name 新名称')
  context.submit(); await tick()
  expect(context.workspace.handleRename).toHaveBeenCalledWith('one', '新名称')
  useWorkspaceStore.getState().setDraft('one', '/name')
  context.render().submit('/name'); await tick()
  expect(context.draft()).toBe('/name')
  context.ui.rename.mock.calls[0]![0]()
  expect(context.draft()).toBe('')
})
it('copies raw assistant text, reports clipboard failures and never copies thinking', async () => {
  const context = setup('/copy')
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  context.submit(); await tick()
  expect(writeText).toHaveBeenCalledWith('**Answer**')
  useWorkspaceStore.getState().setDraft('one', '/copy')
  writeText.mockRejectedValueOnce(new Error('denied'))
  context.submit(); await tick()
  expect(context.render().notice?.error).toBe(true)
  expect(context.draft()).toBe('/copy')
})
it('rejects mutation commands during generation while allowing read-only actions', async () => {
  const context = setup('/model fixture/model/with/slash')
  context.workspace.isActive = true
  for (const text of ['/model', '/compact', '/name Test']) {
    context.render().submit(text); await tick()
    expect(context.render().notice?.error).toBe(true)
  }
  expect(context.workspace.changeModel).not.toHaveBeenCalled()
  expect(context.workspace.handleRename).not.toHaveBeenCalled()
  expect(context.sessionRuns.compact).not.toHaveBeenCalled()
  context.render().submit('/session')
  expect(context.ui.statistics).toHaveBeenCalledOnce()
})
it('rejects extra parameters and draft commands, leaving ordinary prompts and thinking to the existing handler', async () => {
  const context = setup('/copy unexpected')
  context.submit(); await tick()
  expect(context.render().notice?.message).toContain('无需参数')
  expect(context.render().submit('你好 /model')).toBe(false)
  expect(context.render().submit('/modelx')).toBe(false)
  expect(context.render().submit('/thinking high')).toBe(false)
  context.workspace.isDraft = true
  context.render().submit('/settings'); await tick()
  expect(context.ui.settings).not.toHaveBeenCalled()
  expect(context.render().notice?.message).toContain('已有会话')
})

it('clones without a preflight history request, then clears the command and selects the child', async () => {
  const context = setup('/clone')
  expect(context.submit()).toBe(true)
  await tick()
  expect(fetchSessionTurnIndex).not.toHaveBeenCalled()
  expect(context.workspace.createBranch).toHaveBeenCalledWith({ kind: 'clone' })
  expect(context.workspace.selectSession).toHaveBeenCalledWith('child')
  expect(context.draft()).toBe('')
  expect(context.render().notice).toBeUndefined()
})
it('dismisses command failures after two seconds and restarts the timer for repeated failures', async () => {
  vi.useFakeTimers()
  const context = setup('/clone')
  vi.mocked(context.workspace.createBranch).mockRejectedValue(new Error('Clone failed'))
  context.submit(); await tick()
  expect(context.render().notice?.message).toBe('Clone failed')
  vi.advanceTimersByTime(1500)
  expect(context.render().notice?.error).toBe(true)
  context.submit(); await tick()
  context.render()
  vi.advanceTimersByTime(500)
  expect(context.render().notice?.error).toBe(true)
  vi.advanceTimersByTime(1500)
  expect(context.render().notice).toBeUndefined()
  expect(context.draft()).toBe('/clone')
})
it('clears a command error when leaving its session', async () => {
  const context = setup('/clone')
  vi.mocked(context.workspace.createBranch).mockRejectedValueOnce(new Error('Clone failed'))
  context.submit(); await tick(); context.render()
  context.workspace.selectedSessionId = 'two'
  context.render()
  context.workspace.selectedSessionId = 'one'
  expect(context.render().notice).toBeUndefined()
})
it('opens fork selection and only creates the new session after a position is chosen', async () => {
  const context = setup('/fork')
  context.submit(); await tick()
  expect(context.workspace.createBranch).not.toHaveBeenCalled()
  expect(context.draft()).toBe('/fork')
  await context.ui.fork.mock.calls[0]![0]('entry', 'b'.repeat(64))
  expect(context.workspace.createBranch).toHaveBeenCalledWith({ kind: 'fork', entryId: 'entry', revision: 'b'.repeat(64) })
  expect(context.workspace.selectSession).toHaveBeenCalledWith('child')
})
it('ignores repeated clone submissions while creating the child', async () => {
  const context = setup('/clone')
  let release!: (value: any) => void
  vi.mocked(context.workspace.createBranch).mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
  expect(context.submit()).toBe(true)
  expect(context.submit()).toBe(true)
  expect(context.workspace.createBranch).toHaveBeenCalledExactlyOnceWith({ kind: 'clone' })
  release({ session: { id: 'child' }, draft: '' })
  await tick()
  expect(context.workspace.selectSession).toHaveBeenCalledExactlyOnceWith('child')
  expect(context.draft()).toBe('')
})
it('does not navigate or clear input when branch creation fails or another session becomes selected', async () => {
  const context = setup('/clone')
  vi.mocked(context.workspace.createBranch).mockRejectedValueOnce(new Error('History changed'))
  context.submit(); await tick()
  expect(context.draft()).toBe('/clone')
  expect(context.workspace.selectSession).not.toHaveBeenCalled()
  expect(context.render().notice?.message).toBe('History changed')
  let release!: (value: any) => void
  vi.mocked(context.workspace.createBranch).mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
  context.submit(); await tick()
  context.workspace.selectedSessionId = 'two'
  context.render()
  release({ session: { id: 'child' }, draft: '' }); await tick()
  expect(context.workspace.selectSession).not.toHaveBeenCalled()
  expect(context.draft()).toBe('/clone')
})
