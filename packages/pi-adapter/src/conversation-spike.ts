import { SessionManager } from '@earendil-works/pi-coding-agent'

import { createRestrictedAgentSession } from './create-restricted-agent-session.js'

const COMPLETION_PROMPT = 'Reply with exactly PI_NEST_STREAM_COMPLETE and no other text.'
const ABORT_PROMPT = 'Write a numbered list of 200 concise, unique facts about the number 7. Begin with item 1.'

type ConversationPhase = 'complete' | 'abort'

type ConversationPhaseSummary = {
  agentEndCount: number
  assistantStopReason: string | undefined
  textDeltaCount: number
}

export type PiConversationSpikeSummary = {
  aborted: ConversationPhaseSummary & { abortRequested: boolean }
  completed: ConversationPhaseSummary
  cwd: string
  id: string
  model: { provider: string; id: string } | undefined
  modelRestoreWarning: string | undefined
  sessionFile: string
  toolEventCount: number
}

export type PiConversationSpikeTextDelta = {
  delta: string
  phase: ConversationPhase
}

function lastAssistantStopReason(messages: Array<{ role: string }>): string | undefined {
  const lastAssistant = messages.slice().reverse().find((message) => message.role === 'assistant')

  return (lastAssistant as { stopReason?: string } | undefined)?.stopReason
}

export async function runPiConversationSpike(
  cwd: string,
  onTextDelta?: (event: PiConversationSpikeTextDelta) => void,
): Promise<PiConversationSpikeSummary> {
  try {
    const sessionManager = SessionManager.create(cwd)
    const { session, modelFallbackMessage } = await createRestrictedAgentSession(sessionManager, cwd)
    let phase: ConversationPhase = 'complete'
    let abortPromise: Promise<void> | undefined
    let toolEventCount = 0
    const completed: ConversationPhaseSummary = {
      agentEndCount: 0,
      assistantStopReason: undefined,
      textDeltaCount: 0,
    }
    const aborted: PiConversationSpikeSummary['aborted'] = {
      agentEndCount: 0,
      abortRequested: false,
      assistantStopReason: undefined,
      textDeltaCount: 0,
    }
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === 'tool_execution_start' ||
        event.type === 'tool_execution_update' ||
        event.type === 'tool_execution_end'
      ) {
        toolEventCount += 1
      }

      if (event.type === 'agent_end') {
        ;(phase === 'complete' ? completed : aborted).agentEndCount += 1
      }

      if (event.type !== 'message_update' || event.assistantMessageEvent.type !== 'text_delta') {
        return
      }

      const current = phase === 'complete' ? completed : aborted
      current.textDeltaCount += 1
      onTextDelta?.({ delta: event.assistantMessageEvent.delta, phase })

      if (phase === 'abort' && !abortPromise) {
        aborted.abortRequested = true
        abortPromise = session.abort()
      }
    })

    try {
      await session.prompt(COMPLETION_PROMPT)
      completed.assistantStopReason = lastAssistantStopReason(session.messages)

      if (completed.textDeltaCount === 0 || session.getLastAssistantText() !== 'PI_NEST_STREAM_COMPLETE') {
        throw new Error('Pi SDK did not complete the expected streaming response')
      }

      phase = 'abort'
      await session.prompt(ABORT_PROMPT)
      await abortPromise
      aborted.assistantStopReason = lastAssistantStopReason(session.messages)

      if (!aborted.abortRequested || aborted.textDeltaCount === 0 || aborted.assistantStopReason !== 'aborted') {
        throw new Error('Pi SDK did not abort the streaming response')
      }

      if (!session.sessionFile) {
        throw new Error('Pi SDK did not persist the conversation session')
      }

      if (toolEventCount !== 0) {
        throw new Error('Pi SDK emitted tool events despite tools being disabled')
      }

      return {
        aborted,
        completed,
        cwd,
        id: session.sessionId,
        model: session.model && { provider: session.model.provider, id: session.model.id },
        modelRestoreWarning: modelFallbackMessage,
        sessionFile: session.sessionFile,
        toolEventCount,
      }
    } finally {
      unsubscribe()
      session.dispose()
    }
  } catch (cause) {
    throw new Error(`Failed to run Pi conversation spike in cwd: ${cwd}`, { cause })
  }
}
