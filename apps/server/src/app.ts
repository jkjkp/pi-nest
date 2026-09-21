import { listPiSessions, promptPiSession } from '@pi-nest/pi-adapter'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'

const promptSchema = z
  .object({
    prompt: z
      .string()
      .max(20_000)
      .refine((prompt) => prompt.trim().length > 0),
  })
  .strict()

const activeSessionIds = new Set<string>()

export const app = new Hono()
  .get('/api/health', (context) => context.json({ status: 'ok' }))
  .get('/api/sessions', async (context) => {
    try {
      const sessions = await listPiSessions()

      return context.json({
        sessions: sessions.map(({ id, cwd, updatedAt }) => ({ id, cwd, updatedAt })),
      })
    } catch {
      return context.json({ error: 'Failed to list Pi sessions' }, 500)
    }
  })
  .post('/api/sessions/:sessionId/prompts', async (context) => {
    const body = await context.req.json().catch(() => undefined)
    const parsed = promptSchema.safeParse(body)

    if (!parsed.success) return context.json({ error: 'Invalid prompt request' }, 400)

    const sessionId = context.req.param('sessionId')
    let nativeSession

    try {
      nativeSession = (await listPiSessions()).find((session) => session.id === sessionId)
    } catch {
      return context.json({ error: 'Failed to resolve Pi session' }, 500)
    }

    if (!nativeSession) return context.json({ error: 'Pi session not found' }, 404)
    if (!nativeSession.cwd) return context.json({ error: 'Pi session cwd is unavailable' }, 422)
    if (activeSessionIds.has(sessionId)) {
      return context.json({ error: 'Pi session is already running' }, 409)
    }

    const sessionCwd = nativeSession.cwd
    activeSessionIds.add(sessionId)

    return streamSSE(context, async (stream) => {
      const controller = new AbortController()
      let timedOut = false
      let writes = Promise.resolve()
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, 300_000)
      const write = (event: string, data: unknown) => {
        writes = writes.then(() =>
          stream.writeSSE({ event, data: JSON.stringify(data) }).then(() => undefined),
        )
      }

      stream.onAbort(() => controller.abort())

      try {
        const result = await promptPiSession({
          expectedCwd: sessionCwd,
          expectedSessionId: sessionId,
          onTextDelta: (delta) => write('text_delta', { delta }),
          prompt: parsed.data.prompt,
          sessionFile: nativeSession.sessionFile,
          signal: controller.signal,
        })
        await writes

        if (timedOut) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ code: 'PROMPT_TIMEOUT', message: 'Pi session prompt timed out' }),
          })
        } else if (!stream.aborted) {
          await stream.writeSSE({
            event: 'complete',
            data: JSON.stringify({
              model: result.model,
              stopReason: result.stopReason,
              textDeltaCount: result.textDeltaCount,
            }),
          })
        }
      } catch {
        await writes.catch(() => undefined)
        if (!stream.aborted) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ code: 'PROMPT_FAILED', message: 'Pi session prompt failed' }),
          })
        }
      } finally {
        clearTimeout(timeout)
        activeSessionIds.delete(sessionId)
      }
    })
  })
