import {
  createPiSession,
  deletePiSession,
  listPiSessions,
  readPiSettings,
  PiSessionHistorySourceChangedError,
  readPiSessionHistory,
  renamePiSession,
  revealPiWorkspace,
  updatePiSettings,
  type PiSessionSummary,
} from '@pi-nest/pi-adapter'
import { Hono } from 'hono'
import { z } from 'zod'

import { PiRuntimeRegistry } from './pi-runtime-registry.js'

const sessionNameSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict()

const createSessionSchema = z.object({
  cwd: z.string().trim().min(1).max(4_096),
  prompt: z.string().trim().min(1).max(20_000),
}).strict()

const projectCwdSchema = z.object({ cwd: z.string().trim().min(1).max(4_096) }).strict()

const settingsSchema = z.object({
  compactionEnabled: z.boolean().optional(),
  defaultModel: z.string().min(1).max(256).optional(),
  defaultProvider: z.string().min(1).max(256).optional(),
  defaultThinkingLevel: z.string().min(1).max(64).optional(),
  followUpMode: z.enum(['all', 'one-at-a-time']).optional(),
  retryEnabled: z.boolean().optional(),
  steeringMode: z.enum(['all', 'one-at-a-time']).optional(),
}).strict()

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

async function resolveWorkspace(cwd: string) {
  try {
    return (await listPiSessions()).some((session) => session.cwd === cwd)
  } catch {
    return undefined
  }
}

export function createSessionRoutes(runtime = new PiRuntimeRegistry()) {
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
    .post('/sessions', async (context) => {
      const parsed = createSessionSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: 'Invalid session creation request' }, 400)

      const workspace = await resolveWorkspace(parsed.data.cwd)
      if (workspace === undefined) return context.json({ error: 'Failed to resolve Pi workspace' }, 500)
      if (!workspace) return context.json({ error: 'Pi workspace not found' }, 404)

      let created: ReturnType<typeof createPiSession> | undefined
      let busy = false
      try {
        created = createPiSession(parsed.data.cwd)
        const prompt = runtime.beginPrompt(created, parsed.data.prompt)
        if (!prompt) {
          busy = true
          throw new Error('Pi runtime is busy')
        }
        await prompt.accepted
        return context.json({
          session: {
            cwd: created.cwd,
            firstMessage: parsed.data.prompt.replace(/\s+/g, ' ').trim(),
            id: created.id,
            updatedAt: new Date().toISOString(),
          },
        }, 201)
      } catch (cause) {
        if (created) {
          await runtime.deleteSession(created.id).catch(() => undefined)
          await deletePiSession({ expectedCwd: created.cwd, expectedSessionId: created.id, sessionFile: created.sessionFile }).catch(() => undefined)
        }
        if (!busy) console.error('Failed to initialize Pi session', { cause })
        return context.json(
          busy
            ? { error: 'Pi runtime is busy' }
            : { code: 'SESSION_INITIALIZATION_FAILED', error: 'Failed to initialize Pi session' },
          busy ? 409 : 500,
        )
      }
    })
    .post('/projects/reveal', async (context) => {
      const parsed = projectCwdSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: 'Invalid Pi workspace request' }, 400)
      const workspace = await resolveWorkspace(parsed.data.cwd)
      if (workspace === undefined) return context.json({ error: 'Failed to resolve Pi workspace' }, 500)
      if (!workspace) return context.json({ error: 'Pi workspace not found' }, 404)
      try {
        await revealPiWorkspace(parsed.data.cwd)
        return context.body(null, 204)
      } catch {
        return context.json({ error: 'Failed to reveal Pi workspace in Finder' }, 500)
      }
    })
    .get('/sessions/:sessionId/history', async (context) => {
      const sessionId = context.req.param('sessionId')
      if (runtime.isPromptActive(sessionId)) return context.json({ error: 'Pi session is running' }, 409)

      const resolved = await resolveSession(sessionId)
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)
      if (!resolved.session.cwd) return context.json({ error: 'Pi session cwd is unavailable' }, 409)

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
    .get('/sessions/:sessionId/settings', async (context) => {
      const resolved = await resolveSession(context.req.param('sessionId'))
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)
      if (!resolved.session.cwd) return context.json({ error: 'Pi session cwd is unavailable' }, 409)
      try {
        return context.json({ settings: readPiSettings(resolved.session.cwd) })
      } catch {
        return context.json({ error: 'Failed to read Pi settings' }, 500)
      }
    })
    .patch('/sessions/:sessionId/settings', async (context) => {
      const parsed = settingsSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success || Object.keys(parsed.data).length === 0) return context.json({ error: 'Invalid Pi settings' }, 400)
      const resolved = await resolveSession(context.req.param('sessionId'))
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)
      if (!resolved.session.cwd) return context.json({ error: 'Pi session cwd is unavailable' }, 409)
      const finish = runtime.beginGlobalSettingsUpdate()
      if (!finish) return context.json({ error: 'Pi runtime is busy' }, 409)
      try {
        const settings = await updatePiSettings(resolved.session.cwd, parsed.data)
        await finish(true)
        return context.json({ settings })
      } catch {
        await finish(false)
        return context.json({ error: 'Failed to save Pi settings' }, 500)
      }
    })
    .patch('/sessions/:sessionId', async (context) => {
      const parsed = sessionNameSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: 'Invalid session name' }, 400)

      const sessionId = context.req.param('sessionId')
      const resolved = await resolveSession(sessionId)
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)

      const mutation = runtime.beginMutation(sessionId)
      if (!mutation) return context.json({ error: 'Pi session is busy' }, 409)

      let finishMutation: (() => void) | undefined

      try {
        finishMutation = await mutation
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
        finishMutation?.()
      }
    })
    .delete('/sessions/:sessionId', async (context) => {
      const sessionId = context.req.param('sessionId')
      const resolved = await resolveSession(sessionId)
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)

      const mutation = runtime.beginMutation(sessionId)
      if (!mutation) return context.json({ error: 'Pi session is busy' }, 409)

      let finishMutation: (() => void) | undefined

      try {
        finishMutation = await mutation
        await deletePiSession({
          expectedCwd: resolved.session.cwd,
          expectedSessionId: resolved.session.id,
          sessionFile: resolved.session.sessionFile,
        })
        await runtime.deleteSession(sessionId)
        return context.body(null, 204)
      } catch {
        return context.json({ error: 'Failed to delete Pi session' }, 500)
      } finally {
        finishMutation?.()
      }
    })
}
