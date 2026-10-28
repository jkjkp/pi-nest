// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ExtensionUiInline, RuntimeExtensionUi } from './runtime-extension-ui.js'
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
