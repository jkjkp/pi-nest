import {
  deletePiSession,
  listPiSessions,
  PiSessionHistorySourceChangedError,
  promptPiSession,
  readPiSessionHistory,
  renamePiSession,
  type PiSessionSummary,
} from '@pi-nest/pi-adapter'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'

import { createSessionActivity } from './session-activity.js'

const promptSchema = z
  .object({
    prompt: z
      .string()
      .max(20_000)
      .refine((prompt) => prompt.trim().length > 0),
  })
  .strict()

const sessionNameSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict()

type SessionResolution =
  | { kind: 'found'; session: PiSessionSummary }
  | { kind: 'missing' }
  | { kind: 'failed' }

async function resolveSession(sessionId: string): Promise<SessionResolution> {
  try {
    const session = (await listPiSessions()).find((candidate) => candidate.id === sessionId)
    return session ? { kind: 'found', session } : { kind: 'missing' }
  } catch {
    return { kind: 'failed' }
  }
}

export function createSessionRoutes() {
  const activity = createSessionActivity()

  return new Hono()
    .get('/sessions', async (context) => {
      try {
        const sessions = await listPiSessions()

        return context.json({
          sessions: sessions.map(({ id, cwd, name, firstMessage, updatedAt }) => ({ id, cwd, name, firstMessage, updatedAt })),
        })
      } catch {
        return context.json({ error: 'Failed to list Pi sessions' }, 500)
      }
    })
    .get('/sessions/:sessionId/history', async (context) => {
      const sessionId = context.req.param('sessionId')
      if (activity.isPromptActive(sessionId)) return context.json({ error: 'Pi session is running' }, 409)

      const resolved = await resolveSession(sessionId)
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)

      try {
        const history = readPiSessionHistory({
          expectedCwd: resolved.session.cwd,
          expectedSessionId: resolved.session.id,
          sessionFile: resolved.session.sessionFile,
        })
        context.header('Cache-Control', 'no-store')
        return context.json({
          ...history,
          session: { id: resolved.session.id, cwd: resolved.session.cwd, updatedAt: resolved.session.updatedAt },
        })
      } catch (cause) {
        if (cause instanceof PiSessionHistorySourceChangedError) {
          return context.json({ error: 'Pi session changed while reading history' }, 409)
        }
        return context.json({ error: 'Failed to read Pi session history' }, 500)
      }
    })
    .post('/sessions/:sessionId/abort', (context) => {
      if (!activity.abortPrompt(context.req.param('sessionId'))) {
        return context.json({ error: 'Pi session is not running' }, 409)
      }

      return context.json({ status: 'aborting' }, 202)
    })
    .patch('/sessions/:sessionId', async (context) => {
      const parsed = sessionNameSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: 'Invalid session name' }, 400)

      const sessionId = context.req.param('sessionId')
      const resolved = await resolveSession(sessionId)
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)

      const finishMutation = activity.beginMutation(sessionId)
      if (!finishMutation) return context.json({ error: 'Pi session is busy' }, 409)

      try {
        renamePiSession({
          expectedCwd: resolved.session.cwd,
          expectedSessionId: resolved.session.id,
          name: parsed.data.name,
          sessionFile: resolved.session.sessionFile,
        })
        return context.json({ session: { id: resolved.session.id, name: parsed.data.name } })
      } catch {
        return context.json({ error: 'Failed to rename Pi session' }, 500)
      } finally {
        finishMutation()
      }
    })
    .delete('/sessions/:sessionId', async (context) => {
      const sessionId = context.req.param('sessionId')
      const resolved = await resolveSession(sessionId)
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)

      const finishMutation = activity.beginMutation(sessionId)
      if (!finishMutation) return context.json({ error: 'Pi session is busy' }, 409)

      try {
        await deletePiSession({
          expectedCwd: resolved.session.cwd,
          expectedSessionId: resolved.session.id,
          sessionFile: resolved.session.sessionFile,
        })
        return context.body(null, 204)
      } catch {
        return context.json({ error: 'Failed to delete Pi session' }, 500)
      } finally {
        finishMutation()
      }
    })
    .post('/sessions/:sessionId/prompts', async (context) => {
      const body = await context.req.json().catch(() => undefined)
      const parsed = promptSchema.safeParse(body)
      if (!parsed.success) return context.json({ error: 'Invalid prompt request' }, 400)

      const sessionId = context.req.param('sessionId')
      const resolved = await resolveSession(sessionId)
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)
      if (!resolved.session.cwd) return context.json({ error: 'Pi session cwd is unavailable' }, 422)

      const sessionCwd = resolved.session.cwd
      const controller = activity.beginPrompt(sessionId)
      if (!controller) return context.json({ error: 'Pi session is already running' }, 409)

      return streamSSE(context, async (stream) => {
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
            sessionFile: resolved.session.sessionFile,
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
            if (timedOut) {
              await stream.writeSSE({
                event: 'error',
                data: JSON.stringify({ code: 'PROMPT_TIMEOUT', message: 'Pi session prompt timed out' }),
              })
            } else if (controller.signal.aborted) {
              await stream.writeSSE({
                event: 'complete',
                data: JSON.stringify({ model: undefined, stopReason: 'aborted', textDeltaCount: 0 }),
              })
            } else {
              await stream.writeSSE({
                event: 'error',
                data: JSON.stringify({ code: 'PROMPT_FAILED', message: 'Pi session prompt failed' }),
              })
            }
          }
        } finally {
          clearTimeout(timeout)
          activity.finishPrompt(sessionId, controller)
        }
      })
    })
}
