import { piAssistantStopReason } from '@pi-nest/contracts/pi-events'
import type { PiRuntimeCommand, AttachmentRef } from '@pi-nest/contracts'
import { unstable_batchedUpdates } from 'react-dom'
import { stripAnsiText } from './ansi-text.js'
import { isRuntimeConnectionError, RuntimeWebSocketClient, type PiRuntimeEvent, type PiRuntimeModel, type PiRuntimeState } from './runtime-websocket-client.js'
import { activeRuntimeTurn, nativeUserMessage, reconcilePendingInputs, type PromptStatus, type RuntimeTurn } from './session-run-model.js'
import { useWorkspaceStore, type RuntimeStatisticsState } from './workspace-store.js'

export type SessionRunState = Pick<ReturnType<typeof useWorkspaceStore.getState>,
  | 'runs' | 'sessionNotifications' | 'runtimeDetails' | 'runtimeStates' | 'runtimeStatistics'
  | 'appendPendingInput' | 'appendRunEvent' | 'clearRun' | 'completeLatestRunTurn' | 'consumePendingInput'
  | 'markRunExecutionStarted' | 'promotePendingInput' | 'removePendingInput' | 'setRun' | 'updateRun'
  | 'finishNotification' | 'markSessionRead' | 'removeSessionNotification' | 'trackPendingRun'
  | 'clearRuntimeState' | 'setRuntimeDetails' | 'setRuntimeState' | 'setRuntimeStatistics' | 'setWatchState'
  | 'clearExtensionUi' | 'replaceExtensionUi' | 'setDraft' | 'setExtensionStatus' | 'setExtensionWidget'
>
export type SessionRunStateAccess = { getState: () => SessionRunState }

type SessionRunControllerOptions = {
  invalidateHistory: (sessionId: string) => void | Promise<void>
  runtime: RuntimeWebSocketClient
  state?: SessionRunStateAccess
}

export type InputAttachments = { attachments: AttachmentRef[]; attachmentIds: string[]; submissionId: string }
type StartSessionRunOptions = { attachments?: AttachmentRef[]; submissionId?: string; onAccepted?: () => void; historyAnchorId?: string; historyTurnCount?: number; prompt: string; sessionId: string; startedAt?: string }
type ActiveRun = { awaitingRunId: boolean; runId: string | undefined; stopReason: string | undefined }

export type SessionRunController = {
  adopt: (options: StartSessionRunOptions) => void
  compact: (sessionId: string, customInstructions?: string) => Promise<boolean>
  cancelCompact: (sessionId: string) => Promise<void>
  followUp: (sessionId: string, message: string, input?: InputAttachments) => Promise<void>
  getCommands: (sessionId: string) => Promise<PiRuntimeCommand[]>
  getAvailableModels: (sessionId: string) => Promise<PiRuntimeModel[]>
  getAvailableThinkingLevels: (sessionId: string) => Promise<string[]>
  getSessionStatistics: (sessionId: string) => Promise<void>
  getRuntimeState: (sessionId: string) => Promise<PiRuntimeState>
  markSessionRead: (sessionId: string, runId: string) => void
  removeSessionNotification: (sessionId: string) => void
  queuePlanImplementation: (sessionId: string, dialogId: string, prompt: string) => string
  respondToExtension: (sessionId: string, dialogId: string, response: Parameters<RuntimeWebSocketClient['extensionUiResponse']>[2], pendingInputId?: string) => Promise<void>
  openSession: (sessionId: string) => void
  releaseForeground: () => void
  resume: () => void
  resumeRuntime: (sessionId: string) => Promise<void>
  setModel: (sessionId: string, provider: string, modelId: string) => Promise<void>
  setThinkingLevel: (sessionId: string, level: string) => Promise<void>
  start: (options: StartSessionRunOptions) => boolean
  steer: (sessionId: string, message: string, input?: InputAttachments) => Promise<void>
  resumeQueued: (sessionId: string, inputId: string) => Promise<void>
  dropQueued: (sessionId: string, inputId: string) => Promise<void>
  steerQueued: (sessionId: string, inputId: string) => Promise<void>
  retrySteering: (sessionId: string, turnId: string) => Promise<void>
  stop: (sessionId: string) => Promise<boolean>
}

function startsExecution(event: PiRuntimeEvent) {
  const type = event.event.type
  if (type === 'agent_start' || type === 'turn_start' || type === 'message_update' || (typeof type === 'string' && type.startsWith('tool_execution_'))) return true
  if (type !== 'message') return false
  const message = event.event.message
  return Boolean(message && typeof message === 'object' && !Array.isArray(message) && ['assistant', 'toolResult'].includes((message as Record<string, unknown>).role as string))
}

function isExtensionDialog(event: PiRuntimeEvent) {
  const request = event.event
  return request.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(request.method as string)
}

export function createSessionRunController({ invalidateHistory, runtime, state: stateStore = useWorkspaceStore }: SessionRunControllerOptions): SessionRunController {
  const compactions = new Map<string, { cancelled: boolean; started: boolean }>()
  const activeRuns = new Map<string, ActiveRun>()
  const awaitingAgentTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const statisticsRequests = new Map<string, number>()
  const statisticsInFlight = new Map<string, Promise<void>>()
  const statisticsRerun = new Set<string>()
  const completedStatistics = new Map<string, string>()
  const statisticsStateKeys = new Map<string, string>()
  let foregroundSessionId: string | undefined
  let nextPendingInputId = 0
  const queueSyncedSessions = new Set<string>()

  function invalidateStatistics(sessionId: string) {
    statisticsRequests.set(sessionId, (statisticsRequests.get(sessionId) ?? 0) + 1)
    statisticsInFlight.delete(sessionId)
    statisticsRerun.delete(sessionId)
    completedStatistics.delete(sessionId)
    statisticsStateKeys.delete(sessionId)
  }

  function requestStatistics(sessionId: string, rerun = false) {
    const active = statisticsInFlight.get(sessionId)
    if (active) {
      if (rerun) statisticsRerun.add(sessionId)
      return active
    }
    const request = (statisticsRequests.get(sessionId) ?? 0) + 1
    statisticsRequests.set(sessionId, request)
    const write = (update: RuntimeStatisticsState) => {
      if (statisticsRequests.get(sessionId) !== request) return
      const store = stateStore.getState()
      store.setRuntimeStatistics(sessionId, { ...store.runtimeStatistics[sessionId], ...update })
    }
    write({ loading: true, error: undefined })
    let promise!: Promise<void>
    promise = (async () => {
      try { write({ data: await runtime.getSessionStatistics(sessionId) }) }
      catch { write({ error: '统计读取失败，请重试。' }) }
      finally {
        if (statisticsInFlight.get(sessionId) === promise) statisticsInFlight.delete(sessionId)
        if (statisticsRequests.get(sessionId) === request) {
          if (statisticsRerun.delete(sessionId)) {
            write({ loading: true, error: undefined })
            void requestStatistics(sessionId)
          } else write({ loading: false })
        }
      }
    })()
    statisticsInFlight.set(sessionId, promise)
    return promise
  }

  function getSessionStatistics(sessionId: string) {
    return requestStatistics(sessionId)
  }

  async function refreshStatisticsNow(sessionId: string) {
    const active = statisticsInFlight.get(sessionId)
    if (active) await active.catch(() => undefined)
    return requestStatistics(sessionId)
  }

  function requestStateStatistics(sessionId: string, key: string) {
    if (statisticsStateKeys.get(sessionId) === key) return
    statisticsStateKeys.set(sessionId, key)
    void requestStatistics(sessionId, true)
  }

  function refreshCompletionStatistics(sessionId: string, runId: string | undefined) {
    if (runId && completedStatistics.get(sessionId) === runId) return
    if (runId) completedStatistics.set(sessionId, runId)
    void requestStatistics(sessionId, true)
  }

  function clearAwaitingAgentCheck(sessionId: string) {
    const timer = awaitingAgentTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    awaitingAgentTimers.delete(sessionId)
  }

  function checkAwaitingAgent(sessionId: string, runId: string | undefined) {
    clearAwaitingAgentCheck(sessionId)
    awaitingAgentTimers.set(sessionId, setTimeout(() => {
      awaitingAgentTimers.delete(sessionId)
      const activeRun = activeRuns.get(sessionId)
      if (!activeRun || activeRun.runId !== runId || stateStore.getState().runs[sessionId]?.status !== 'awaiting_agent') return
      void runtime.getRuntimeState(sessionId).then((state) => {
        const current = activeRuns.get(sessionId)
        if (!current || current.runId !== runId || stateStore.getState().runs[sessionId]?.status !== 'awaiting_agent') return
        stateStore.getState().updateRun(sessionId, { waitingMessage: state.isStreaming ? 'Pi 正在处理，等待首个执行事件…' : '正在同步会话状态…' })
        if (!state.isStreaming) void invalidateHistory(sessionId)
      }).catch(() => undefined)
    }, 4_000))
  }

  function finishRun(sessionId: string, runId: string | undefined, stopReason: string) {
    refreshCompletionStatistics(sessionId, runId)
    const store = stateStore.getState()
    // A fresh watch of old history must not create an unread reply.
    if (runId && store.sessionNotifications[sessionId]?.pendingRunId !== runId) return
    clearAwaitingAgentCheck(sessionId)
    activeRuns.delete(sessionId)
    store.completeLatestRunTurn(sessionId, new Date().toISOString())
    const unconfirmedAttachments = store.runs[sessionId]?.turns.some((turn) => turn.attachments?.length && !turn.events.some((event) => nativeUserMessage(event)))
    if (unconfirmedAttachments) store.updateRun(sessionId, { attachmentWarning: 'Pi 已处理输入，但未观察到附件用户消息；请检查扩展是否接管。' })
    store.updateRun(sessionId, { status: stopReason === 'error' ? 'error' : stopReason === 'aborted' ? 'aborted' : 'complete', stopReason })
    const visible = foregroundSessionId === sessionId && (typeof document === 'undefined' || document.visibilityState === 'visible')
    if (runId) store.finishNotification(sessionId, runId, !visible, stopReason !== 'error' && stopReason !== 'aborted')
    void invalidateHistory(sessionId)
    if (runtime.watchedSessions().some((watch) => watch.sessionId === sessionId && watch.role === 'background')) void runtime.unwatch(sessionId)
  }

  function cancelNotification(sessionId: string) {
    const store = stateStore.getState()
    const runId = store.sessionNotifications[sessionId]?.pendingRunId
    if (runId) store.finishNotification(sessionId, runId, false, false)
  }

  function fail(sessionId: string, message: string) {
    clearAwaitingAgentCheck(sessionId)
    cancelNotification(sessionId)
    if (!activeRuns.delete(sessionId)) return
    stateStore.getState().updateRun(sessionId, { error: message, status: 'error' })
    void invalidateHistory(sessionId)
  }

  function beginRun({ historyAnchorId, historyTurnCount, prompt, sessionId, startedAt, attachments, submissionId }: StartSessionRunOptions, status: Extract<PromptStatus, 'awaiting_agent' | 'submitted' | 'running'> = 'submitted', awaitingRunId = false, runId?: string) {
    const completedTurns = stateStore.getState().runs[sessionId]?.turns.filter((turn) => turn.completedAt || (turn.steering && turn.steering.status !== 'applied')) ?? []
    const submittedAt = startedAt ?? new Date().toISOString()
    activeRuns.set(sessionId, { awaitingRunId, runId, stopReason: undefined })
    if (runId) stateStore.getState().trackPendingRun(sessionId, runId)
    stateStore.getState().setRun(sessionId, {
      status,
      systemEvents: [],
      pendingInputs: stateStore.getState().runs[sessionId]?.pendingInputs ?? [],
      turns: [...completedTurns, { runId, events: [], ...(historyAnchorId ? { historyAnchorId } : {}), ...(historyTurnCount === undefined ? {} : { historyTurnCount }), id: `pending:${sessionId}:${crypto.randomUUID()}`, prompt, attachments, submissionId, submittedAt, startedAt: submittedAt }],
    })
  }

  const handlePiEvent = (event: PiRuntimeEvent) => {
    const store = stateStore.getState()
    const raw = event.event
    if (raw.type === 'queue_update' && Array.isArray(raw.steering) && raw.steering.every((message) => typeof message === 'string') && Array.isArray(raw.followUp) && raw.followUp.every((message) => typeof message === 'string')) {
      queueSyncedSessions.add(event.sessionId)
      store.updateRun(event.sessionId, { pendingInputs: reconcilePendingInputs(store.runs[event.sessionId]?.pendingInputs ?? [], { steering: raw.steering, followUp: raw.followUp, ...(Array.isArray(raw.inputs) ? { inputs: raw.inputs as import('@pi-nest/contracts').PiQueuedInput[] } : {}), ...(Array.isArray(raw.steeringInputs) ? { steeringInputs: raw.steeringInputs as import('@pi-nest/contracts').PiQueuedInput[] } : {}) }, String(event.sequence)) })
    }
    if (raw.type === 'thinking_level_changed' && typeof raw.level === 'string' && runtime.shouldApplyExtensionUi(event)) {
      const details = store.runtimeDetails[event.sessionId]
      store.setRuntimeDetails(event.sessionId, { ...(details ?? { isCompacting: false, isStreaming: store.runtimeStates[event.sessionId]?.lifecycle === 'active' }), thinkingLevel: raw.level })
    }
    if (raw.type === 'extension_ui_request') {
      if (raw.method === 'set_editor_text' && typeof raw.text === 'string') store.setDraft(event.sessionId, stripAnsiText(raw.text))
      if (runtime.shouldApplyExtensionUi(event)) {
        if (raw.method === 'setStatus' && typeof raw.statusKey === 'string' && raw.statusKey) store.setExtensionStatus(event.sessionId, raw.statusKey, typeof raw.statusText === 'string' ? raw.statusText : undefined)
        if (raw.method === 'setWidget' && typeof raw.widgetKey === 'string' && raw.widgetKey) store.setExtensionWidget(event.sessionId, raw.widgetKey, Array.isArray(raw.widgetLines) && raw.widgetLines.every((line) => typeof line === 'string') ? raw.widgetLines : undefined)
      }
    }
    if (raw.type === 'auto_compaction_end' && runtime.shouldApplyExtensionUi(event)) void requestStatistics(event.sessionId, true)
    let activeRun = activeRuns.get(event.sessionId)
    if (!activeRun && event.event.type === 'agent_start' && event.runId && store.sessionNotifications[event.sessionId]?.completedRunId !== event.runId) {
      clearAwaitingAgentCheck(event.sessionId)
      activeRun = { awaitingRunId: false, runId: event.runId, stopReason: undefined }
      activeRuns.set(event.sessionId, activeRun)
      stateStore.getState().updateRun(event.sessionId, { executionStartedAt: undefined, stopReason: undefined })
      stateStore.getState().promotePendingInput(event.sessionId, event.observedAt)
    }
    if (!activeRun) return
    if (activeRun.awaitingRunId || (activeRun.runId !== undefined && event.runId !== activeRun.runId)) return
    if (activeRun.runId === undefined && event.runId !== undefined) activeRun.runId = event.runId
    if (activeRun.runId) store.trackPendingRun(event.sessionId, activeRun.runId)
    if (startsExecution(event)) {
      clearAwaitingAgentCheck(event.sessionId)
      if (Number.isFinite(Date.parse(event.observedAt))) stateStore.getState().markRunExecutionStarted(event.sessionId, event.observedAt)
      stateStore.getState().updateRun(event.sessionId, { status: 'running', waitingMessage: undefined })
    }
    if (isExtensionDialog(event)) stateStore.getState().updateRun(event.sessionId, { status: 'awaiting_input', waitingMessage: undefined })
    if (raw.type === 'extension_ui_resolved' && store.runs[event.sessionId]?.status === 'awaiting_input') stateStore.getState().updateRun(event.sessionId, { status: 'running', waitingMessage: undefined })
    const userInput = nativeUserMessage(event)
    if (userInput && !queueSyncedSessions.has(event.sessionId)) stateStore.getState().consumePendingInput(event.sessionId, userInput)
    stateStore.getState().appendRunEvent(event.sessionId, event)
    activeRun.stopReason = piAssistantStopReason(event.event) ?? activeRun.stopReason
    if (event.event.type !== 'agent_settled') return
    if (event.event.aborted === true) activeRun.stopReason = 'aborted'

    finishRun(event.sessionId, activeRun.runId, activeRun.stopReason ?? (store.runs[event.sessionId]?.status === 'aborting' ? 'aborted' : 'stop'))
  }

  const streamEvents: PiRuntimeEvent[] = []
  let streamTimer: ReturnType<typeof setTimeout> | undefined
  const flushStreamEvents = () => {
    clearTimeout(streamTimer)
    streamTimer = undefined
    unstable_batchedUpdates(() => {
      for (const event of streamEvents.splice(0)) handlePiEvent(event)
    })
  }
  runtime.onPiEvent((event) => {
    streamEvents.push(event)
    // Keep every delta, but render at most once per 32 ms burst; boundaries flush immediately.
    if (event.event.type !== 'message_update') flushStreamEvents()
    else streamTimer ??= setTimeout(flushStreamEvents, 32)
  })

  runtime.onError((error) => {
    flushStreamEvents()
    if (error.code === 'RUNTIME_RESTARTED' && error.sessionId) {
      invalidateStatistics(error.sessionId)
      stateStore.getState().clearRuntimeState(error.sessionId)
      activeRuns.delete(error.sessionId)
      clearAwaitingAgentCheck(error.sessionId)
      cancelNotification(error.sessionId)
      stateStore.getState().updateRun(error.sessionId, { error: 'Pi 运行服务已重启，本轮已中断。', status: 'error' })
      stateStore.getState().setWatchState(error.sessionId, 'watching')
      void invalidateHistory(error.sessionId)
      return
    }
    if (error.code === 'RESUME_GAP' && error.sessionId) {
      clearAwaitingAgentCheck(error.sessionId)
      activeRuns.delete(error.sessionId)
      clearRunForResync(error.sessionId)
      stateStore.getState().setWatchState(error.sessionId, 'watching')
      void invalidateHistory(error.sessionId)
      return
    }
    const sessionIds = error.sessionId ? [error.sessionId] : [...activeRuns.keys()]
    for (const sessionId of sessionIds) fail(sessionId, error.message)
  })

  runtime.onResyncRequired((message) => {
    invalidateStatistics(message.sessionId)
    stateStore.getState().clearRuntimeState(message.sessionId)
    stateStore.getState().clearExtensionUi(message.sessionId)
    clearAwaitingAgentCheck(message.sessionId)
    activeRuns.delete(message.sessionId)
    clearRunForResync(message.sessionId)
    stateStore.getState().setWatchState(message.sessionId, 'watching')
    void invalidateHistory(message.sessionId)
  })

  function clearRunForResync(sessionId: string) {
    const store = stateStore.getState()
    const turns = store.runs[sessionId]?.turns.filter((turn) => turn.steering && turn.steering.status !== 'applied').map((turn) => ({ ...turn, steering: { ...turn.steering!, status: turn.steering!.status === 'failed' ? 'failed' as const : 'unknown' as const } })) ?? []
    if (turns.length) store.setRun(sessionId, { turns, pendingInputs: [], status: 'idle', systemEvents: [] })
    else store.clearRun(sessionId)
  }

  runtime.onSessionSnapshot((snapshot) => {
    flushStreamEvents()
    const store = stateStore.getState()
    if ((store.runtimeStates[snapshot.sessionId]?.revision ?? -1) > snapshot.runtime.revision) return
    store.replaceExtensionUi(snapshot.sessionId, snapshot.extensionUi)
    store.setRuntimeState(snapshot.sessionId, snapshot.runtime)
    applyModelStatus({ ...snapshot.runtime, sessionId: snapshot.sessionId })
    if (!snapshot.completedRun && (snapshot.runtime.lifecycle === 'idle' || snapshot.runtime.lifecycle === 'active')) requestStateStatistics(snapshot.sessionId, `${snapshot.runtime.lifecycle}:${snapshot.runtime.revision}`)
    stateStore.getState().setWatchState(snapshot.sessionId, 'ready')
    if (snapshot.completedRun) finishRun(snapshot.sessionId, snapshot.completedRun.runId, snapshot.completedRun.stopReason)
    if (snapshot.activeTurn) store.trackPendingRun(snapshot.sessionId, snapshot.activeTurn.runId)
    if (snapshot.activeTurn && !activeRuns.has(snapshot.sessionId)) {
      const status = snapshot.activeTurn.waitingForExtension ? 'awaiting_input' : 'running'
      if (status === 'running' && snapshot.activeTurn.prompt) beginRun({ ...snapshot.activeTurn, prompt: snapshot.activeTurn.prompt, sessionId: snapshot.sessionId }, status, false, snapshot.activeTurn.runId)
      else {
        activeRuns.set(snapshot.sessionId, { awaitingRunId: false, runId: snapshot.activeTurn.runId, stopReason: undefined })
        stateStore.getState().setRun(snapshot.sessionId, { pendingInputs: store.runs[snapshot.sessionId]?.pendingInputs ?? [], status, systemEvents: [], turns: [] })
      }
    }
    if (snapshot.inputQueue) {
      queueSyncedSessions.add(snapshot.sessionId)
      stateStore.getState().updateRun(snapshot.sessionId, { pendingInputs: reconcilePendingInputs(stateStore.getState().runs[snapshot.sessionId]?.pendingInputs ?? [], snapshot.inputQueue, String(snapshot.atSequence)) })
    }
  })

  runtime.onRuntimeStatus((status) => {
    flushStreamEvents()
    const store = stateStore.getState()
    if ((store.runtimeStates[status.sessionId]?.revision ?? -1) > status.revision) return
    store.setRuntimeState(status.sessionId, status)
    applyModelStatus(status)
    if (status.lifecycle === 'idle' && status.completedRun) finishRun(status.sessionId, status.completedRun.runId, status.completedRun.stopReason)
    if (status.lifecycle === 'notLoaded' || status.lifecycle === 'failed') {
      store.updateRun(status.sessionId, { pendingInputs: store.runs[status.sessionId]?.pendingInputs?.filter((input) => input.mode === 'plan_implementation' || input.recoveryRequired) ?? [] })
      invalidateStatistics(status.sessionId)
      store.setRuntimeStatistics(status.sessionId, { ...store.runtimeStatistics[status.sessionId], loading: false, error: '等待 Pi 运行恢复后更新统计。' })
    }
    if (status.lifecycle === 'idle' && !status.completedRun) requestStateStatistics(status.sessionId, `idle:${status.revision}`)
    if (status.lifecycle === 'failed') store.clearExtensionUi(status.sessionId)
    if (status.lifecycle === 'active' && !activeRuns.has(status.sessionId)) {
      activeRuns.set(status.sessionId, { awaitingRunId: false, runId: undefined, stopReason: undefined })
      stateStore.getState().setRun(status.sessionId, { pendingInputs: [], status: 'running', systemEvents: [], turns: [] })
    }
    if (status.lifecycle === 'failed') fail(status.sessionId, status.error ?? 'Pi runtime failed')
    if (status.lifecycle === 'idle' && !activeRuns.has(status.sessionId) && !store.sessionNotifications[status.sessionId]?.pendingRunId && runtime.watchedSessions().some((watch) => watch.sessionId === status.sessionId && watch.role === 'background')) {
      void runtime.unwatch(status.sessionId)
      void invalidateHistory(status.sessionId)
    }
  })

  function applyModelStatus(status: { sessionId: string; model?: { id: string; provider: string }; thinkingLevel?: string; lifecycle: string }) {
    if ((!status.model && status.thinkingLevel === undefined) || status.lifecycle === 'failed' || status.lifecycle === 'notLoaded') return
    const store = stateStore.getState()
    store.setRuntimeDetails(status.sessionId, { ...store.runtimeDetails[status.sessionId], isCompacting: false, isStreaming: status.lifecycle === 'active', ...(status.model ? { model: status.model } : {}), ...(status.thinkingLevel !== undefined ? { thinkingLevel: status.thinkingLevel } : {}) })
  }

  const loadingRuntimes = new Map<string, Promise<void>>()
  function resumeRuntime(sessionId: string) {
    const current = loadingRuntimes.get(sessionId)
    if (current) return current
    const promise = runtime.resumeRuntime(sessionId).finally(() => loadingRuntimes.delete(sessionId))
    loadingRuntimes.set(sessionId, promise)
    return promise
  }

  async function getRuntimeState(sessionId: string) {
    const state = await runtime.getRuntimeState(sessionId)
    const store = stateStore.getState()
    store.setRuntimeDetails(sessionId, state)
    void getSessionStatistics(sessionId)
    if (store.runs[sessionId] && state.model?.id && state.model.provider) store.updateRun(sessionId, { model: `${state.model.provider}/${state.model.id}` })
    return state
  }

  async function submitRunningInput(sessionId: string, message: string, mode: 'follow_up' | 'steer', input?: InputAttachments) {
    if (mode === 'steer') return submitSteering(sessionId, message, () => runtime.steer(sessionId, message, ...(input ? [{ attachmentIds: input.attachmentIds, submissionId: input.submissionId }] : [])), undefined, undefined, input)
    const id = input?.submissionId ?? `pending-input:${++nextPendingInputId}`
    stateStore.getState().appendPendingInput(sessionId, { id, message, mode, ...(input ? { attachments: input.attachments, submissionId: input.submissionId } : {}), submittedAt: new Date().toISOString(), submitting: true })
    try {
      await runtime.followUp(sessionId, message, ...(input ? [{ attachmentIds: input.attachmentIds, submissionId: input.submissionId }] : []))
      const store = stateStore.getState()
      store.updateRun(sessionId, { pendingInputs: store.runs[sessionId]?.pendingInputs?.map((input) => input.id === id ? { ...input, submitting: false } : input) ?? [] })
    } catch (cause) {
      stateStore.getState().removePendingInput(sessionId, id)
      throw cause
    }
  }

  function updateSteering(sessionId: string, id: string, status: NonNullable<RuntimeTurn['steering']>['status'], error?: string) {
    const store = stateStore.getState()
    store.updateRun(sessionId, { turns: store.runs[sessionId]?.turns.map((turn) => turn.id !== id || turn.steering?.status === 'applied' ? turn : { ...turn, steering: { ...turn.steering, status, error } }) ?? [] })
  }

  async function submitSteering(sessionId: string, message: string, send: () => Promise<unknown>, queuedInputId?: string, retryId?: string, input?: InputAttachments) {
    const store = stateStore.getState()
    const run = store.runs[sessionId]
    const id = retryId ?? `steering:${crypto.randomUUID()}`
    const submittedAt = new Date().toISOString()
    if (retryId) updateSteering(sessionId, id, 'sending')
    else store.updateRun(sessionId, { turns: [...(run?.turns ?? []), { id, runId: activeRuns.get(sessionId)?.runId, prompt: message, ...(input ? { attachments: input.attachments, submissionId: input.submissionId } : {}), events: [], startedAt: submittedAt, submittedAt, executionStartedAt: run?.executionStartedAt ?? (run && activeRuntimeTurn(run.turns)?.startedAt), steering: { status: 'sending', queuedInputId } }] })
    try {
      await send()
      updateSteering(sessionId, id, 'accepted')
    } catch (cause) {
      updateSteering(sessionId, id, isRuntimeConnectionError(cause) ? 'unknown' : 'failed', cause instanceof Error ? cause.message : '引导发送失败')
      throw cause
    }
  }

  async function steerQueued(sessionId: string, inputId: string, retryId?: string) {
    const inputs = stateStore.getState().runs[sessionId]?.pendingInputs?.filter((input) => input.mode === 'follow_up') ?? []
    const index = inputs.findIndex((input) => input.id === inputId)
    if (index < 0 || inputs[index]!.submitting) throw new Error('排队消息已发生变化，请重试。')
    return submitSteering(sessionId, inputs[index]!.message, () => runtime.steerQueued(sessionId, inputs[index]!.message, index, ...(inputs[index]!.submissionId ? [inputs[index]!.id] : [])), inputId, retryId, inputs[index]!.attachments?.length ? { attachments: inputs[index]!.attachments!, attachmentIds: inputs[index]!.attachments!.map((a) => a.id), submissionId: inputs[index]!.submissionId! } : undefined)
  }

  return {
    adopt: (options) => {
      if (!activeRuns.has(options.sessionId)) {
        beginRun(options, 'awaiting_agent')
        checkAwaitingAgent(options.sessionId, undefined)
      }
    },
    compact: async (sessionId, customInstructions) => {
      const operation = { cancelled: false, started: false }
      compactions.set(sessionId, operation)
      let aborted = false
      const unsubscribe = runtime.onPiEvent((event) => {
        if (event.sessionId === sessionId && event.event.type === 'compaction_end' && event.event.aborted === true) aborted = true
      })
      try {
        await resumeRuntime(sessionId)
        if (operation.cancelled) return false
        operation.started = true
        try { await runtime.compact(sessionId, customInstructions) }
        catch (cause) { if (aborted) return false; throw cause }
        operation.started = false
        try { await invalidateHistory(sessionId) }
        catch { /* The history query reports refresh errors; compaction has already succeeded. */ }
        await refreshStatisticsNow(sessionId)
        return true
      } finally { unsubscribe(); compactions.delete(sessionId) }
    },
    cancelCompact: async (sessionId) => {
      const operation = compactions.get(sessionId)
      if (!operation || operation.cancelled) return
      operation.cancelled = true
      try { if (operation.started) await runtime.abort(sessionId) }
      catch (cause) { operation.cancelled = false; throw cause }
    },
    followUp: (sessionId, message, input) => submitRunningInput(sessionId, message, 'follow_up', input),
    getCommands: async (sessionId) => (await runtime.getCommands(sessionId)).commands,
    getAvailableModels: async (sessionId) => (await runtime.getAvailableModels(sessionId)).models,
    getAvailableThinkingLevels: async (sessionId) => (await runtime.getAvailableThinkingLevels(sessionId)).levels,
    getSessionStatistics,
    getRuntimeState,
    markSessionRead: (sessionId, runId) => stateStore.getState().markSessionRead(sessionId, runId),
    removeSessionNotification: (sessionId) => stateStore.getState().removeSessionNotification(sessionId),
    queuePlanImplementation: (sessionId, dialogId, prompt) => {
      const id = `plan-implementation:${dialogId}`
      stateStore.getState().appendPendingInput(sessionId, { id, message: prompt, mode: 'plan_implementation', submittedAt: new Date().toISOString() })
      return id
    },
    respondToExtension: async (sessionId, dialogId, response, pendingInputId) => {
      try { await runtime.extensionUiResponse(sessionId, dialogId, response) }
      catch (cause) {
        if (pendingInputId) stateStore.getState().removePendingInput(sessionId, pendingInputId)
        throw cause
      }
    },
    openSession: (sessionId) => {
      void (async () => {
        const previous = foregroundSessionId
        foregroundSessionId = sessionId
        stateStore.getState().setWatchState(sessionId, 'watching')
        if (previous && previous !== sessionId) {
          const lifecycle = stateStore.getState().runtimeStates[previous]?.lifecycle
          if (lifecycle === 'active' || lifecycle === 'loading' || activeRuns.has(previous) || stateStore.getState().sessionNotifications[previous]?.pendingRunId) await runtime.watch(previous, 'background')
          else await runtime.unwatch(previous)
        }
        await runtime.watch(sessionId, 'foreground')
        stateStore.getState().setWatchState(sessionId, 'ready')
      })().catch(() => undefined)
    },
    releaseForeground: () => {
      const sessionId = foregroundSessionId
      foregroundSessionId = undefined
      if (!sessionId) return
      const lifecycle = stateStore.getState().runtimeStates[sessionId]?.lifecycle
      if (lifecycle === 'active' || lifecycle === 'loading' || activeRuns.has(sessionId) || stateStore.getState().sessionNotifications[sessionId]?.pendingRunId) {
        void runtime.watch(sessionId, 'background')
      } else {
        void runtime.unwatch(sessionId)
      }
    },
    resume: () => {
      for (const watch of runtime.watchedSessions()) {
        if (watch.role === 'foreground') foregroundSessionId = watch.sessionId
        stateStore.getState().setWatchState(watch.sessionId, 'watching')
        void runtime.watch(watch.sessionId, watch.role, watch.after).then(() => stateStore.getState().setWatchState(watch.sessionId, 'ready')).catch((cause) => {
          if (!isRuntimeConnectionError(cause)) fail(watch.sessionId, cause instanceof Error ? cause.message : 'Pi session replay failed')
        })
      }
    },
    resumeRuntime,
    setModel: async (sessionId, provider, modelId) => { await resumeRuntime(sessionId); await runtime.setModel(sessionId, provider, modelId); await getRuntimeState(sessionId) },
    setThinkingLevel: async (sessionId, level) => { await resumeRuntime(sessionId); await runtime.setThinkingLevel(sessionId, level); await getRuntimeState(sessionId) },
    start: (options) => {
      const { prompt, sessionId } = options
      if (activeRuns.has(sessionId)) return false
      beginRun(options, 'submitted', true)
      void (async () => {
        try {
          stateStore.getState().setWatchState(sessionId, 'watching')
          await runtime.watch(sessionId, 'foreground')
          stateStore.getState().setWatchState(sessionId, 'ready')
          await resumeRuntime(sessionId)
          const accepted = await runtime.prompt(sessionId, prompt, ...(options.attachments?.length ? [{ attachmentIds: options.attachments.map((a) => a.id), submissionId: options.submissionId! }] : []))
          options.onAccepted?.()
          const activeRun = activeRuns.get(sessionId)
          if (!activeRun || typeof accepted?.runId !== 'string') throw new Error('Pi runtime did not acknowledge this prompt')
          activeRun.awaitingRunId = false
          activeRun.runId = accepted.runId
          stateStore.getState().trackPendingRun(sessionId, accepted.runId)
          stateStore.getState().updateRun(sessionId, { status: 'awaiting_agent' })
          checkAwaitingAgent(sessionId, accepted.runId)
        } catch (cause) {
          if (!isRuntimeConnectionError(cause)) fail(sessionId, cause instanceof Error ? cause.message : 'Pi session prompt failed')
        }
      })()
      return true
    },
    stop: async (sessionId) => {
      const previousStatus = stateStore.getState().runs[sessionId]?.status
      if (!activeRuns.has(sessionId) || !previousStatus || !['submitted', 'awaiting_agent', 'running'].includes(previousStatus)) return false
      clearAwaitingAgentCheck(sessionId)
      stateStore.getState().updateRun(sessionId, { error: undefined, status: 'aborting' })
      try {
        await runtime.abort(sessionId)
        return true
      } catch (cause) {
        if (activeRuns.has(sessionId)) {
          stateStore.getState().updateRun(sessionId, {
            error: cause instanceof Error ? cause.message : 'Pi session could not be stopped', status: previousStatus,
          })
        }
        return false
      }
    },
    steer: (sessionId, message, input) => submitRunningInput(sessionId, message, 'steer', input),
    resumeQueued: async (sessionId, inputId) => { await runtime.watch(sessionId); await runtime.resumeQueued(sessionId, inputId) },
    dropQueued: async (sessionId, inputId) => { await runtime.watch(sessionId); await runtime.dropQueued(sessionId, inputId) },
    steerQueued,
    retrySteering: async (sessionId, turnId) => {
      const turn = stateStore.getState().runs[sessionId]?.turns.find((turn) => turn.id === turnId)
      if (!turn?.prompt || turn.steering?.status !== 'failed') return
      if (turn.steering.queuedInputId) return steerQueued(sessionId, turn.steering.queuedInputId, turnId)
      return submitSteering(sessionId, turn.prompt, () => runtime.steer(sessionId, turn.prompt!, turn.attachments?.length ? { attachmentIds: turn.attachments.map((a) => a.id), submissionId: turn.submissionId! } : undefined), undefined, turnId, turn.attachments?.length ? { attachments: turn.attachments, attachmentIds: turn.attachments.map((a) => a.id), submissionId: turn.submissionId! } : undefined)
    },
  }
}
