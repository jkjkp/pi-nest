// @vitest-environment happy-dom
import { act, createRef, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PiQueuedInput } from '@pi-nest/contracts'
import type { SessionRunController } from './session-run-controller.js'
import { WorkspaceComposer } from './workspace-composer.js'
import { useWorkspaceSession } from './use-workspace-session.js'
import { useWorkspaceStore } from './workspace-store.js'
import { setDraftAttachments, useAttachmentStore } from './attachment-draft.js'
import { RuntimeConnectionError } from './runtime-websocket-client.js'
import { configurationRequest, fetchProjects, fetchSessions, fetchSessionHistory, fetchSessionTurnIndex } from './workspace-api.js'

vi.mock('./workspace-api.js', async (original) => ({ ...await original<typeof import('./workspace-api.js')>(), configurationRequest: vi.fn(), fetchProjects: vi.fn(), fetchSessions: vi.fn(), fetchSessionHistory: vi.fn(), fetchSessionTurnIndex: vi.fn() }))

const firstId = '00000000-0000-4000-8000-000000000001'
const secondId = '00000000-0000-4000-8000-000000000002'
const attachment = { id: '00000000-0000-4000-8000-000000000003', name: 'input.txt', size: 4, kind: 'file' as const, mediaType: 'text/plain' }
const queued = (id = firstId): PiQueuedInput => ({ id, message: 'same message', attachments: [attachment], attachmentIds: [attachment.id], submissionId: id })
let root: Root
let container: HTMLDivElement
let client: QueryClient
let workspace: ReturnType<typeof useWorkspaceSession>
let controller: SessionRunController

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  useAttachmentStore.setState({ drafts: {}, draftIds: {}, submissions: {} })
  useWorkspaceStore.setState({ drafts: {}, messageEdits: {}, runs: { a: { status: 'running', turns: [], systemEvents: [], pendingInputs: [firstId, secondId].map((id) => ({ ...queued(id), mode: 'follow_up', submittedAt: 'now' })) } }, runtimeStates: {}, runtimeDetails: {}, watchStates: {} })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const sessions = [{ id: 'a', cwd: '/fixture' }, { id: 'b', cwd: '/fixture' }]
  client.setQueryData(['sessions'], sessions)
  client.setQueryData(['projects'], [])
  vi.mocked(fetchSessions).mockResolvedValue(sessions)
  vi.mocked(fetchProjects).mockResolvedValue([])
  vi.mocked(fetchSessionHistory).mockResolvedValue({ session: sessions[0]!, entries: [], revision: 'a'.repeat(64), hasEarlier: false })
  vi.mocked(fetchSessionTurnIndex).mockResolvedValue({ revision: 'a'.repeat(64), entries: [] })
  vi.mocked(configurationRequest).mockResolvedValue({ attachments: [attachment] })
  controller = {
    openSession: vi.fn(), releaseForeground: vi.fn(), getCommands: vi.fn(async () => []),
    dropQueued: vi.fn(async (sessionId, inputId) => {
      const input = useWorkspaceStore.getState().runs[sessionId]?.pendingInputs?.find((input) => input.id === inputId)
      if (!input) throw new Error('排队消息已变化')
      useWorkspaceStore.getState().removePendingInput(sessionId, inputId)
      return input
    }),
    followUp: vi.fn(async () => undefined), steerQueued: vi.fn(),
  } as unknown as SessionRunController
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  client.clear(); container.remove(); vi.unstubAllGlobals()
})

async function render() {
  const textareaRef = createRef<HTMLTextAreaElement>()
  function Probe() {
    const state = useWorkspaceSession(controller)
    useEffect(() => { workspace = state }, [state])
    return <WorkspaceComposer state={state} commands={{ busy: false, cancelCompact: vi.fn(), compacted: false, notice: undefined, submit: vi.fn(() => false) }} sessionRuns={controller} textareaRef={textareaRef} setComposer={vi.fn()} onSubmit={(mode) => state.submitPrompt(mode)} onAbort={vi.fn()} controls={null} canQuery={false} settingsBusy={false} error={state.controlError} onError={vi.fn()} />
  }
  await act(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?session=a']}><Probe /></MemoryRouter></QueryClientProvider>))
}
function button(label: string, index = 0) { return [...container.querySelectorAll('button')].filter((button) => button.textContent === label)[index]! }
function deferredDrop() {
  let resolve!: (input: PiQueuedInput) => void
  let reject!: (cause: Error) => void
  vi.mocked(controller.dropQueued).mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no }))
  return { resolve: (input = queued()) => { useWorkspaceStore.getState().removePendingInput('a', input.id); resolve(input) }, reject: (cause: Error) => reject(cause) }
}

it('moves only the selected duplicate into the composer with attachments, focuses it, and resubmits with a fresh ID', async () => {
  useAttachmentStore.setState({ submissions: { a: { fingerprint: JSON.stringify(['same message', [attachment.id]]), id: firstId } } })
  await render()
  await act(() => button('编辑', 1).click())
  expect(controller.dropQueued).toHaveBeenCalledWith('a', secondId)
  expect(workspace.currentRun?.pendingInputs?.map((input) => input.id)).toEqual([firstId])
  expect(workspace.prompt).toBe('same message')
  expect(workspace.attachmentDraft.snapshot()).toEqual([attachment])
  expect(document.activeElement).toBe(container.querySelector('textarea'))
  expect(workspace.currentRun?.turns).toEqual([])
  await act(() => workspace.submitPrompt())
  expect(controller.followUp).toHaveBeenCalledWith('a', 'same message', expect.objectContaining({ attachmentIds: [attachment.id], submissionId: expect.not.stringMatching(/00000000-0000-4000-8000-00000000000[12]/) }))
})

it('edits a plain-text queue entry without sending it until the user submits again', async () => {
  useWorkspaceStore.getState().updateRun('a', { pendingInputs: [{ id: firstId, message: 'plain text', mode: 'follow_up', submittedAt: 'now' }] })
  await render()
  await act(() => button('编辑').click())
  expect(workspace.prompt).toBe('plain text')
  expect(workspace.attachmentDraft.items).toHaveLength(0)
  expect(workspace.currentRun?.pendingInputs).toHaveLength(0)
  expect(controller.followUp).not.toHaveBeenCalled()
  await act(() => workspace.submitPrompt())
  expect(controller.followUp).toHaveBeenCalledWith('a', 'plain text')
})

it.each([false, true])('cancels without replaying or changing an existing draft (%s)', async (hasDraft) => {
  if (hasDraft) { useWorkspaceStore.getState().setDraft('a', 'keep draft'); setDraftAttachments('a', [attachment]) }
  await render()
  await act(() => button('取消').click())
  expect(workspace.prompt).toBe(hasDraft ? 'keep draft' : '')
  expect(workspace.attachmentDraft.items).toHaveLength(hasDraft ? 1 : 0)
  expect(workspace.currentRun?.pendingInputs?.map((input) => input.id)).toEqual([secondId])
  expect(workspace.currentRun?.turns).toEqual([])
})

it.each(['text', 'attachment'])('protects an existing %s draft from editing', async (kind) => {
  if (kind === 'text') useWorkspaceStore.getState().setDraft('a', 'keep draft')
  else setDraftAttachments('a', [attachment])
  await render()
  expect(button('编辑').disabled).toBe(true)
  expect(button('编辑').title).toBe('请先发送或清空当前草稿')
  await act(() => workspace.editQueued(firstId))
  expect(controller.dropQueued).not.toHaveBeenCalled()
})

it('waits for removal, locks the composer, and ignores repeated clicks and submission until acknowledged', async () => {
  const pending = deferredDrop()
  await render()
  await act(() => button('编辑').click())
  expect(workspace.prompt).toBe('')
  expect(container.querySelector('textarea')?.disabled).toBe(true)
  expect(button('取消').disabled).toBe(true)
  await act(async () => { await workspace.editQueued(firstId); workspace.setDraft('a', 'overwrite'); workspace.submitPrompt() })
  expect(controller.dropQueued).toHaveBeenCalledOnce()
  expect(controller.followUp).not.toHaveBeenCalled()
  await act(() => pending.resolve())
  expect(workspace.prompt).toBe('same message')
  expect(container.querySelector('textarea')?.disabled).toBe(false)
  expect(document.activeElement).toBe(container.querySelector('textarea'))
})

it.each([new Error('消息已开始执行'), new RuntimeConnectionError('Disconnected')])('keeps the composer and queue intact on an unconfirmed or rejected removal: %s', async (cause) => {
  const pending = deferredDrop()
  await render()
  await act(() => button('编辑').click())
  await act(() => pending.reject(cause))
  expect(workspace.prompt).toBe('')
  expect(workspace.currentRun?.pendingInputs).toHaveLength(2)
  expect(workspace.attachmentDraft.items).toHaveLength(0)
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.querySelector('textarea')?.disabled).toBe(false)
})

it('restores into the original session after navigation without changing or focusing the new session draft', async () => {
  const pending = deferredDrop()
  useWorkspaceStore.getState().setDraft('b', 'other session draft')
  await render()
  await act(() => button('编辑').click())
  await act(() => workspace.selectSession('b'))
  const input = container.querySelector('textarea')!
  await act(() => pending.resolve())
  expect(workspace.selectedSessionId).toBe('b')
  expect(workspace.prompt).toBe('other session draft')
  expect(workspace.attachmentDraft.items).toHaveLength(0)
  expect(useWorkspaceStore.getState().drafts.a).toBe('same message')
  expect(useAttachmentStore.getState().drafts.a?.[0]?.ref).toEqual(attachment)
  expect(document.activeElement).not.toBe(input)
})

it('keeps failed attachments visible and requiring repair after editing a recovered message', async () => {
  useWorkspaceStore.getState().updateRun('a', { status: 'error', pendingInputs: [{ ...queued(), mode: 'follow_up', submittedAt: 'now', error: '附件已损坏', recoveryRequired: true }] })
  await render()
  expect(button('编辑').disabled).toBe(false)
  await act(() => button('编辑').click())
  expect(workspace.prompt).toBe('same message')
  expect(workspace.attachmentDraft.items[0]).toMatchObject({ status: 'failed', error: '附件已损坏', ref: attachment })
  expect(workspace.attachmentDraft.busy).toBe(true)
})
