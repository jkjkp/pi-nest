// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ExtensionStatusNotice, ExtensionUiInline, RuntimeExtensionUi } from './runtime-extension-ui.js'
import { createSessionRunController } from './session-run-controller.js'
import type { PiRuntimeEvent } from './runtime-websocket-client.js'
import { useWorkspaceStore } from './workspace-store.js'

it.each(['accepted', 'rejected', 'not-pending'])('keeps the plan reply and queue consistent through the real UI and controller: %s', async (outcome) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const listeners = new Set<(event: PiRuntimeEvent) => void>()
  const noopSubscription = () => () => undefined
  let resolve!: () => void
  let reject!: (cause: Error) => void
  const response = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  const runtime = {
    onPiEvent: (listener: (event: PiRuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onError: noopSubscription, onRuntimeStatus: noopSubscription,
    onSessionSnapshot: noopSubscription, onResyncRequired: noopSubscription,
    shouldApplyExtensionUi: () => true,
    extensionUiResponse: vi.fn(() => response),
  }
  useWorkspaceStore.setState({ runs: {}, runtimeStates: {}, sessionNotifications: {} })
  const controller = createSessionRunController({ runtime: runtime as never, invalidateHistory: vi.fn() })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    await act(() => root.render(<RuntimeExtensionUi runtime={runtime as never} sessionRuns={controller}><ExtensionUiInline sessionId="session-a" planTurnId="plan-turn" /></RuntimeExtensionUi>))
    await act(() => {
      const event = { sessionId: 'session-a', runId: 'run-1', sequence: 1, observedAt: 'now', event: { type: 'extension_ui_request', method: 'select', id: 'plan', title: 'Proposed plan ready. What next?', options: ['Implement here', 'Start fresh and implement'] } }
      for (const listener of listeners) listener(event)
    })
    const implement = [...element.querySelectorAll('button')].find((button) => button.textContent === '在当前会话执行')!
    await act(() => { implement.click(); implement.click() })
    expect(runtime.extensionUiResponse).toHaveBeenCalledExactlyOnceWith('session-a', 'plan', { value: 'Implement here' })
    expect(useWorkspaceStore.getState().runs['session-a']?.pendingInputs).toEqual([expect.objectContaining({ id: 'plan-implementation:plan', message: 'Implement the plan.', mode: 'plan_implementation' })])
    expect(implement.disabled).toBe(true)
    await act(async () => {
      if (outcome === 'accepted') resolve()
      else reject(Object.assign(new Error('回复失败'), { code: outcome === 'not-pending' ? 'EXTENSION_UI_NOT_PENDING' : 'COMMAND_FAILED' }))
      await Promise.resolve()
    })
    expect(useWorkspaceStore.getState().runs['session-a']?.pendingInputs?.length).toBe(outcome === 'accepted' ? 1 : 0)
    if (outcome === 'rejected') {
      expect(element.textContent).toContain('回复失败')
      expect(implement.disabled).toBe(false)
    } else expect(element.querySelector('[aria-label="计划操作"]')).toBeNull()
  } finally {
    await act(() => root.unmount())
    element.remove()
    vi.unstubAllGlobals()
  }
})

it('scopes notices to the active session and expires warnings', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  const listeners = new Set<(event: PiRuntimeEvent) => void>()
  const runtime = {
    onPiEvent: (listener: (event: PiRuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onSessionSnapshot: () => () => undefined,
    onRuntimeStatus: () => () => undefined, onResyncRequired: () => () => undefined,
    shouldApplyExtensionUi: vi.fn(() => true),
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const render = (sessionId: string) => root.render(<RuntimeExtensionUi runtime={runtime as never} sessionRuns={{} as never} activeSessionId={sessionId}><span>workspace</span></RuntimeExtensionUi>)
  const notify = (sessionId: string, sequence: number, message: string) => {
    for (const listener of listeners) listener({ sessionId, sequence, observedAt: 'now', event: { type: 'extension_ui_request', method: 'notify', notifyType: 'warning', message } })
  }
  try {
    await act(() => render('session-a'))
    await act(() => notify('session-a', 1, 'invalid parameter'))
    expect(element.textContent).toContain('invalid parameter')
    await act(() => render('session-b'))
    expect(element.textContent).not.toContain('invalid parameter')
    await act(() => notify('session-a', 2, 'background warning'))
    expect(element.textContent).not.toContain('background warning')
    await act(() => notify('session-b', 3, 'current warning'))
    expect(element.textContent).toContain('current warning')
    await act(() => { vi.advanceTimersByTime(500) })
    expect(element.textContent).toContain('current warning')
    await act(() => { vi.advanceTimersByTime(4500) })
    expect(element.textContent).not.toContain('current warning')
    runtime.shouldApplyExtensionUi.mockReturnValue(false)
    await act(() => notify('session-b', 3, 'replayed warning'))
    expect(element.textContent).not.toContain('replayed warning')
  } finally {
    await act(() => root.unmount())
    element.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})


it('anchors status feedback at the composer, replaces it, and expires 500ms after the latest notice', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  const listeners = new Set<(event: PiRuntimeEvent) => void>()
  const runtime = {
    onPiEvent: (listener: (event: PiRuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onSessionSnapshot: () => () => undefined, onRuntimeStatus: () => () => undefined, onResyncRequired: () => () => undefined,
    shouldApplyExtensionUi: () => true,
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const render = (sessionId: string) => root.render(<RuntimeExtensionUi runtime={runtime as never} sessionRuns={{} as never} activeSessionId={sessionId}><div data-slot="message-composer" className="relative"><ExtensionStatusNotice sessionId={sessionId} /><textarea /></div></RuntimeExtensionUi>)
  const notify = (message: string, sequence: number) => {
    for (const listener of listeners) listener({ sessionId: 'a', sequence, observedAt: 'now', event: { type: 'extension_ui_request', method: 'notify', notifyType: 'info', message } })
  }
  try {
    await act(() => render('a'))
    await act(() => notify('Ponytail: current off • default full', 1))
    const toast = element.querySelector('[data-slot="extension-status-notice"]')!
    expect(toast.closest('[data-slot="message-composer"]')).not.toBeNull()
    expect(toast.className).toContain('pointer-events-none')
    expect(toast.className).toContain('bottom-full')
    expect(toast.className).toContain('bg-gray-600')
    expect(toast.className).toContain('text-white')
    expect(toast.querySelector('button')).toBeNull()
    await act(() => { vi.advanceTimersByTime(300); notify('Ponytail: current full • default full', 2) })
    expect(element.textContent).not.toContain('current off')
    await act(() => { vi.advanceTimersByTime(499) })
    expect(element.textContent).toContain('current full')
    await act(() => { vi.advanceTimersByTime(1) })
    expect(element.querySelector('[data-slot="extension-status-notice"]')).toBeNull()
    await act(() => notify('third notice', 3))
    await act(() => render('b'))
    expect(element.textContent).not.toContain('third notice')
    await act(() => render('a'))
    expect(element.textContent).not.toContain('third notice')
  } finally {
    await act(() => root.unmount())
    element.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
