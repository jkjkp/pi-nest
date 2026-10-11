export type PiRuntimeEvent = {
  event: Record<string, unknown>
  observedAt: string
  runId?: string
  sequence: number
  sessionId: string
  turnId?: string
}

export type RuntimeError = { code: string; id?: string; message: string; sessionId?: string; type: 'error' }
export type RuntimeLifecycle = 'notLoaded' | 'loading' | 'idle' | 'active' | 'failed'
export type RuntimeFailureKind = 'process_error' | 'process_exit' | 'protocol_error' | 'rpc_error' | 'rpc_timeout' | 'startup_timeout'
export type RuntimeStatus = { error?: string; failureKind?: RuntimeFailureKind; lifecycle: RuntimeLifecycle; revision: number; sessionId: string }
export type PiRuntimeExtensionUi = { freshness: 'known' | 'restored' | 'unknown'; statuses: Record<string, string>; widgets: Record<string, string[]> }
export type PiRuntimeSessionSnapshot = {
  activeTurn?: { prompt?: string; runId: string; startedAt: string; waitingForExtension?: true }
  atSequence: number
  extensionUi: PiRuntimeExtensionUi
  pendingExtensionDialogs: PiRuntimeEvent[]
  replayAfter?: number
  runtime: Omit<RuntimeStatus, 'sessionId'>
  sessionId: string
}
export type RuntimeCommandPayload = { sessionId: string } & (
  | { type: 'watch'; resume?: { after: number } }
  | { type: 'unwatch' | 'resume' | 'abort' | 'compact' | 'get_runtime_state' | 'get_available_models' | 'get_available_thinking_levels' }
  | { type: 'prompt' | 'steer' | 'follow_up'; message: string }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'extension_ui_response'; dialogId: string; value?: unknown; confirmed?: boolean; cancelled?: boolean }
)
export type RuntimeCommand = RuntimeCommandPayload & { id: string }

export type RuntimeAck = { command: string; data?: unknown; id: string; sessionId: string; type: 'ack' }
export type RuntimePromptAck = { runId: string }
export type ResyncRequired = { reason: 'event_buffer_expired' | 'sequence_gap'; sessionId: string; type: 'resync_required' }
export type RuntimeMessage = RuntimeAck | RuntimeError | ResyncRequired | ({ type: 'pi_event' } & PiRuntimeEvent) | ({ type: 'session_snapshot' } & SessionSnapshot) | ({ type: 'runtime_status' } & RuntimeStatus)
export type SessionSnapshot = Omit<PiRuntimeSessionSnapshot, 'pendingExtensionDialogs'> & { pendingExtensionDialogs?: PiRuntimeEvent[] }

export type PiRuntimeState = {
  followUpMode?: string
  isCompacting: boolean
  isStreaming: boolean
  model?: { id?: string; provider?: string }
  steeringMode?: string
  thinkingLevel?: string
}
export type PiRuntimeModel = { id: string; name?: string; provider: string }

export type PiSessionSummary = {
  cwd?: string
  firstMessage?: string
  id: string
  name?: string
  updatedAt?: string
}

export type PiSessionsResponse = { sessions: PiSessionSummary[] }

export type PiSessionHistoryEntry = {
  id: string
  parentId: string | null
  raw: Record<string, unknown>
  timestamp: string
  type: string
}

export type PiSessionHistoryResponse = PiSessionHistory & { session: PiSessionSummary }

export type PiSessionTurnIndexEntry = {
  id: string
  index: number
  promptPreview: string
  startedAt: string
}

export type PiSessionTurnIndex = { entries: PiSessionTurnIndexEntry[]; revision: string }

export type PiRuntimeSettings = {
  compactionEnabled: boolean
  defaultModel?: string
  defaultProvider?: string
  defaultThinkingLevel?: string
  followUpMode: 'all' | 'one-at-a-time'
  retryEnabled: boolean
  steeringMode: 'all' | 'one-at-a-time'
}
export type PiSettingsSnapshot = { effective: PiRuntimeSettings; global: PiRuntimeSettings; project: Partial<PiRuntimeSettings> }

export type PiSettingsUpdate = Partial<PiRuntimeSettings>
export type PiSessionHistory = {
  beforeCursor?: string
  entries: PiSessionHistoryEntry[]
  hasEarlier: boolean
  revision: string
}

