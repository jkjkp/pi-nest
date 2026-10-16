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
export type RuntimeStatus = { completedRun?: PiRuntimeSessionSnapshot['completedRun']; thinkingLevel?: string; model?: { id: string; provider: string }; error?: string; failureKind?: RuntimeFailureKind; lifecycle: RuntimeLifecycle; revision: number; sessionId: string }
export type PiRuntimeExtensionUi = { freshness: 'known' | 'restored' | 'unknown'; statuses: Record<string, string>; widgets: Record<string, string[]> }
export type PiRuntimeSessionSnapshot = {
  inputQueue?: { steering: string[]; followUp: string[] }
  activeTurn?: { prompt?: string; runId: string; startedAt: string; waitingForExtension?: true }
  completedRun?: { runId: string; stopReason: string }
  atSequence: number
  extensionUi: PiRuntimeExtensionUi
  pendingExtensionDialogs: PiRuntimeEvent[]
  replayAfter?: number
  runtime: Omit<RuntimeStatus, 'sessionId'>
  sessionId: string
}
export type RuntimeCommandPayload = { sessionId: string } & (
  | { type: 'watch'; resume?: { after: number } }
  | { type: 'unwatch' | 'resume' | 'abort' | 'get_runtime_state' | 'get_session_stats' | 'get_available_models' | 'get_available_thinking_levels' | 'get_commands' }
  | { type: 'prompt' | 'steer' | 'follow_up'; message: string }
  | { type: 'steer_queued'; message: string; index: number }
  | { type: 'compact'; customInstructions?: string }
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
export type PiRuntimeCommand = { name: string; description?: string; source: 'extension' | 'prompt' | 'skill' }

export type PiSessionSummary = {
  createdAt?: string
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
export type PiSettingsSnapshot = { effective: PiRuntimeSettings; global: Partial<PiRuntimeSettings>; project: Partial<PiRuntimeSettings> }

export type PiSettingsUpdate = Partial<PiRuntimeSettings>
export type PiSessionHistory = {
  beforeCursor?: string
  entries: PiSessionHistoryEntry[]
  hasEarlier: boolean
  revision: string
}


export type PiRuntimeStatistics = {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
  autoCompactionEnabled?: boolean
  cacheHitRate?: number
}

export type PiSettingsCategory = 'models' | 'credentials' | 'custom-models' | 'mcp' | 'resources' | 'advanced'
export type PiConfigScope = 'global' | 'project'
export type PiConfigDocument = { revision: string; entries: Record<string, Record<string, unknown>>; autoEnableCodemode?: boolean }
export type PiResourceSettings = { packages: (string | { source: string; autoload?: boolean; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] })[]; extensions: string[]; skills: string[]; prompts: string[]; themes: string[] }
export type PiAdvancedSettings = { transport: 'auto' | 'sse' | 'websocket' | 'websocket-cached'; httpIdleTimeoutMs: number; cacheWarming: 'off' | 'streaming' | 'idle'; enableSkillCommands: boolean; enabledModels?: string[] }
export type PiConfigurationSnapshot = {
  settings: PiSettingsSnapshot
  resources: PiResourceSettings
  projectResources?: Partial<PiResourceSettings>
  advanced: PiAdvancedSettings
  customModels: PiConfigDocument
  mcp: PiConfigDocument
  projectMcp?: PiConfigDocument
  projectTrusted: boolean
  errors?: Partial<Record<'custom-models' | 'mcp' | 'project-mcp', string>>
  providers: { id: string; name: string; credentialType?: 'api_key' | 'oauth'; source?: string; apiKeyLogin: boolean; builtin?: boolean }[]
  models: PiCatalogModel[]
}
export type PiConfigurationUpdate =
  | { category: 'models'; values: PiSettingsUpdate }
  | { category: 'advanced'; values: Partial<PiAdvancedSettings> }
  | { category: 'resources'; scope: PiConfigScope; values: Partial<PiResourceSettings> }
  | { category: 'custom-models' | 'mcp'; scope: PiConfigScope; revision: string; name: string; value: Record<string, unknown> | null }
  | { category: 'credentials'; provider: string; apiKey: string | null }
export type PiMcpDiagnostics = { servers: { name: string; state: string; tools: string[] }[]; hasErrors: boolean }

export type PiCatalogModel = PiRuntimeModel & { thinkingLevels: string[]; definition?: Record<string, unknown> }
export type PiModelDiscoveryRequest = { provider: string; connection: { baseUrl: string; api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'; apiKey?: string; headers?: Record<string, string> } }
export type PiDiscoveredModel = { id: string; name?: string }

export type PiSessionBranchRequest = { kind: 'clone' } | { kind: 'fork'; entryId: string; revision: string }
export type PiSessionBranchResponse = { session: PiSessionSummary; draft: string }
