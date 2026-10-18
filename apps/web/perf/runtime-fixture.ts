import type { PiRuntimeEvent } from '../src/runtime-websocket-client.js'

/** Synthetic transport: real controller/store/projection, no sockets or model calls. */
export function runtimeFixture() {
  let listener: (event: PiRuntimeEvent) => void = () => {}
  let sequence = 0
  const noop = () => () => {}
  return {
    onPiEvent: (callback: typeof listener) => { listener = callback; return () => { listener = () => {} } },
    onError: noop, onRuntimeStatus: noop, onSessionSnapshot: noop, onResyncRequired: noop,
    watch: async () => {}, unwatch: async () => {}, watchedSessions: () => [], resumeRuntime: async () => {},
    prompt: async (sessionId: string) => ({ runId: sessionId }), abort: async () => {}, shouldApplyExtensionUi: () => true,
    getSessionStatistics: async () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    getRuntimeState: async () => ({ isStreaming: true, isCompacting: false }),
    emit: (sessionId: string, event: Record<string, unknown>) => listener({ sessionId, runId: sessionId, turnId: `turn:${sessionId}`, sequence: ++sequence, observedAt: new Date().toISOString(), event }),
  }
}
