// @vitest-environment happy-dom
import { act, createRef, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceComposer } from './workspace-composer.js'
import type { SessionRunController } from './session-run-controller.js'

type Props = ComponentProps<typeof WorkspaceComposer>
let root: Root
let container: HTMLDivElement
let client: QueryClient
let props: Props
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  props = {
    state: {
      selectedSessionId: 'a', selectedSession: { id: 'a' }, isDraft: false, draftProject: undefined,
      creatingDraft: false, prompt: 'next', currentRun: undefined, history: undefined,
      setDraft: vi.fn(), setDraftPrompt: vi.fn(), status: 'running', isActive: true, submittingInput: false,
      steerQueued: vi.fn(), planStatus: '', planPolicy: undefined, extensionStatus: '', planTurnId: undefined,
      retryHistory: vi.fn(), setPendingJump: vi.fn(),
      attachmentDraft: { items: [], add: vi.fn(), busy: false } as unknown as Props['state']['attachmentDraft'],
    },
    commands: { busy: false, notice: undefined, submit: vi.fn(() => false) },
    sessionRuns: { getCommands: vi.fn(async () => []) } as unknown as SessionRunController,
    textareaRef: createRef(), setComposer: vi.fn(), onSubmit: vi.fn(), onAbort: vi.fn(),
    controls: <span>model controls</span>, canQuery: false, settingsBusy: false, onError: vi.fn(),
  }
})
afterEach(async () => { await act(() => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals() })
async function render() { await act(() => root.render(<QueryClientProvider client={client}><WorkspaceComposer {...props} /></QueryClientProvider>)) }

it('preserves queue, steering, composition keys and the dialog focus ref when switching sessions', async () => {
  await render()
  const input = container.querySelector('textarea')!
  for (const options of [{}, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { isComposing: true }]) {
    await act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })))
  }
  expect(props.onSubmit).toHaveBeenCalledTimes(2)
  expect(props.onSubmit).toHaveBeenNthCalledWith(1, 'follow_up')
  expect(props.onSubmit).toHaveBeenNthCalledWith(2, 'steer')
  expect(container.querySelector('[aria-label="停止生成"]')).not.toBeNull()
  expect(props.textareaRef.current).toBe(input)
  props = { ...props, state: { ...props.state, selectedSessionId: 'b', selectedSession: { id: 'b' }, prompt: 'another draft' } }
  await render()
  const next = container.querySelector('textarea')!
  expect(next).not.toBe(input)
  expect(props.textareaRef.current).toBe(next)
  expect(next.value).toBe('another draft')
  expect(props.sessionRuns.getCommands).not.toHaveBeenCalled()
})

it('keeps attachment-only submission gated by upload state and forwards pasted files', async () => {
  props = { ...props, state: { ...props.state, status: 'idle', isActive: false, prompt: '', attachmentDraft: { ...props.state.attachmentDraft, busy: true, items: [{ id: 'one', name: 'file.txt', size: 4, status: 'uploading' }] } } }
  await render()
  expect(container.querySelector<HTMLButtonElement>('[aria-label="发送提示词"]')?.disabled).toBe(true)
  props.state.attachmentDraft = { ...props.state.attachmentDraft, busy: false, items: [{ id: 'one', name: 'file.txt', size: 4, status: 'ready' }] }
  await render()
  const send = container.querySelector<HTMLButtonElement>('[aria-label="发送提示词"]')!
  expect(send.disabled).toBe(false)
  await act(() => send.click())
  expect(props.onSubmit).toHaveBeenCalledOnce()
  expect(props.state.attachmentDraft.items).toHaveLength(1)
  const file = new File(['test'], 'pasted.txt', { type: 'text/plain' })
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files: [file] } })
  await act(() => container.querySelector('textarea')!.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
  expect(props.state.attachmentDraft.add).toHaveBeenCalledWith([file])
})
