import { SessionManager } from '@earendil-works/pi-coding-agent'

import { createRestrictedAgentSession } from './create-restricted-agent-session.js'

export type PiPromptSessionResult = {
  cwd: string
  id: string
  messageCountAfter: number
  messageCountBefore: number
  model: { provider: string; id: string } | undefined
  stopReason: string | undefined
  textDeltaCount: number
  toolEventCount: number
}

export type PiPromptSessionOptions = {
  expectedCwd: string
  expectedSessionId: string
  onTextDelta?: (delta: string) => void
  prompt: string
  sessionFile: string
  signal?: AbortSignal
}

function lastAssistantStopReason(messages: Array<{ role: string }>) {
  const lastAssistant = messages.findLast((message) => message.role === 'assistant')

  return (lastAssistant as { stopReason?: string } | undefined)?.stopReason
}

export async function promptPiSession({
  expectedCwd,
  expectedSessionId,
  onTextDelta,
  prompt,
  sessionFile,
  signal,
}: PiPromptSessionOptions): Promise<PiPromptSessionResult> {
  try {
    if (signal?.aborted) throw new Error('Pi session prompt was aborted before startup')

    const sessionManager = SessionManager.open(sessionFile)
    const header = sessionManager.getHeader()

    if (
      !header ||
      header.cwd !== expectedCwd ||
      sessionManager.getSessionId() !== expectedSessionId ||
      sessionManager.getSessionFile() !== sessionFile
    ) {
      throw new Error('Pi SDK did not open the requested native session')
    }

    const { session } = await createRestrictedAgentSession(sessionManager, expectedCwd)
    let abortError: unknown
    let abortPromise: Promise<void> | undefined
    let textDeltaCount = 0
    let toolEventCount = 0
    const abort = () => {
      abortPromise ??= session.abort().catch((cause: unknown) => {
        abortError = cause
      })
    }
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === 'tool_execution_start' ||
        event.type === 'tool_execution_update' ||
        event.type === 'tool_execution_end'
      ) {
        toolEventCount += 1
      }

      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        textDeltaCount += 1
        onTextDelta?.(event.assistantMessageEvent.delta)
      }
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()

    try {
      if (session.sessionId !== expectedSessionId || session.sessionFile !== sessionFile) {
        throw new Error('Pi AgentSession did not keep the requested native session binding')
      }
      if (signal?.aborted) {
        await abortPromise
        if (abortError) throw abortError
        throw new Error('Pi session prompt was aborted before it started')
      }

      const messageCountBefore = session.messages.length
      await session.prompt(prompt, { expandPromptTemplates: false })
      await abortPromise

      if (abortError) throw abortError
      if (toolEventCount !== 0) throw new Error('Pi SDK emitted tool events despite tools being disabled')

      const messageCountAfter = session.messages.length
      const stopReason = lastAssistantStopReason(session.messages)

      if (messageCountAfter <= messageCountBefore || !stopReason) {
        throw new Error('Pi SDK did not append a completed assistant message')
      }

      return {
        cwd: expectedCwd,
        id: expectedSessionId,
        messageCountAfter,
        messageCountBefore,
        model: session.model && { provider: session.model.provider, id: session.model.id },
        stopReason,
        textDeltaCount,
        toolEventCount,
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      unsubscribe()
      session.dispose()
    }
  } catch (cause) {
    throw new Error(`Failed to prompt Pi session: ${sessionFile}`, { cause })
  }
}
