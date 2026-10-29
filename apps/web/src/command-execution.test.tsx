// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CommandComposer } from './command-composer.js'
import { useWorkspaceCommands } from './use-workspace-commands.js'
import { useWorkspaceStore } from './workspace-store.js'
import type { SessionRunController } from './session-run-controller.js'
import type { useWorkspaceSession } from './use-workspace-session.js'

let root: Root
let container: HTMLDivElement
let client: QueryClient
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useWorkspaceStore.setState({ drafts: {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(async () => {
  await act(() => root.unmount())
  client.clear()
  container.remove()
  vi.unstubAllGlobals()
})

async function setup(initial = '/com') {
  let finish!: (completed: boolean) => void
  let fail!: (cause: Error) => void
  const compact = vi.fn(() => new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject }))
  const start = vi.fn(() => true)
  const sessionRuns = { compact, start, getCommands: vi.fn(async () => []) } as unknown as SessionRunController
  const textareaRef = createRef<HTMLTextAreaElement>()
  const ui = { fork: vi.fn(), rename: vi.fn(), statistics: vi.fn(), settings: vi.fn() }
  function Harness() {
    const value = useWorkspaceStore((state) => state.drafts.one ?? '')
    const commands = useWorkspaceCommands({ selectedSessionId: 'one', selectedSession: { id: 'one' }, runtimeStates: {}, modelStatus: 'unloaded', thinkingStatus: 'unloaded' } as ReturnType<typeof useWorkspaceSession>, sessionRuns, ui)
    function submit() {
      if (!commands.submit(value)) sessionRuns.start({ sessionId: 'one', prompt: value })
    }
    return <><CommandComposer value={value} onValueChange={(text) => useWorkspaceStore.getState().setDraft('one', text)}
      onExecuteCommand={commands.submit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }} textareaRef={textareaRef} sessionId="one" canQuery={false} sessionRuns={sessionRuns} />
      <button onClick={submit}>发送</button>
      <span role="status">{commands.compacted ? '上下文已压缩' : commands.notice?.message}</span></>
  }
  useWorkspaceStore.getState().setDraft('one', initial)
  await act(() => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>))
  const input = container.querySelector('textarea')!
  await act(() => { input.focus(); input.setSelectionRange(initial.length, initial.length) })
  return {
    input, compact, start, ui,
    enter: () => act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }),
    finish: (completed = true) => act(async () => { finish(completed) }),
    fail: () => act(async () => { fail(new Error('压缩失败')) }),
    edit: (text: string) => act(() => useWorkspaceStore.getState().setDraft('one', text)),
  }
}

it.each(['Enter', 'click'])('consumes a compact candidate without writing completion text: %s', async (method) => {
  const context = await setup()
  const writes: string[] = []
  const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
    if (state.drafts.one !== previous.drafts.one) writes.push(state.drafts.one!)
  })
  try {
    if (method === 'Enter') await context.enter()
    else await act(() => container.querySelector<HTMLButtonElement>('[role="option"]')!.click())
    expect(context.compact).toHaveBeenCalledExactlyOnceWith('one', undefined)
    expect(context.input.value).toBe('')
    expect(writes).toEqual([''])
    await context.finish()
    expect(context.input.value).toBe('')
    expect(container.textContent).toContain('上下文已压缩')
  } finally { unsubscribe() }
})

it.each(['Enter', 'send'])('sends a question about compact as ordinary text with %s', async (method) => {
  const text = '/compact 是干啥用的？'
  const context = await setup(text)
  if (method === 'Enter') await context.enter()
  else await act(() => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(context.compact).not.toHaveBeenCalled()
  expect(context.start).toHaveBeenCalledExactlyOnceWith({ sessionId: 'one', prompt: text })
  expect(container.textContent).not.toContain('压缩上下文…')
  expect(container.textContent).not.toContain('Already compacted')
})

it('passes only explicitly separated instructions to Pi', async () => {
  const context = await setup('/compact -- 保留接口设计')
  await context.enter()
  expect(context.compact).toHaveBeenCalledExactlyOnceWith('one', '保留接口设计')
  expect(context.start).not.toHaveBeenCalled()
  await context.finish()
})

it('never restores the submitted command on failure', async () => {
  const context = await setup()
  await context.enter()
  await context.fail()
  expect(context.input.value).toBe('')
  expect(container.textContent).toContain('压缩失败')
})

it('keeps a newly typed identical command after successful compaction', async () => {
  const context = await setup('/compact')
  await context.enter()
  await context.edit('/compact ')
  await context.finish()
  expect(context.input.value).toBe('/compact ')
})

it('does not restore a failed command after the user types and clears a new draft', async () => {
  const context = await setup()
  await context.enter()
  await context.edit('新草稿')
  await context.edit('')
  await context.fail()
  expect(context.input.value).toBe('')
})

it('leaves the composer empty after cancellation', async () => {
  const context = await setup()
  await context.enter()
  await context.finish(false)
  expect(context.input.value).toBe('')
  expect(container.textContent).toContain('已取消上下文压缩')
})
