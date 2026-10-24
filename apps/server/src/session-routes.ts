import { AttachmentError } from './attachment-store.js'
import { HistorySnapshotExpired } from './session-history-snapshots.js'
import { runtimeSettingsSchema } from './configuration-schema.js'
import type { PiSessionsResponse, PiSessionHistoryResponse } from '@pi-nest/contracts'
import {
  branchPiSession,
  readPiSessionForkSource,
  PiSessionBranchTargetError,
  createPiSession,
  deletePiSession,
  listPiSessions,
  PiSessionHistoryCursorError,
  readPiSettings,
  PiSessionHistorySourceChangedError,
  renamePiSession,
  revealPiWorkspace,
  updatePiSettings,
  type PiSessionSummary,
} from '@pi-nest/pi-adapter'
import { Hono } from 'hono'
import { z } from 'zod'

import { ProjectRegistry } from './project-registry.js'
import { RuntimeSecurity } from './runtime-security.js'
import { PiRuntimeRegistry } from './pi-runtime-registry.js'

const sessionNameSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict()

const createSessionSchema = z.object({
  cwd: z.string().trim().min(1).max(4_096),
  prompt: z.string().trim().max(20_000),
  attachmentIds: z.array(z.string().regex(/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/)).min(1).max(8).optional(),
  submissionId: z.string().uuid().optional(),
  draftId: z.string().uuid().optional(),
  initialSettings: z.object({
    model: z.object({ provider: z.string().trim().min(1).max(512), id: z.string().trim().min(1).max(512) }).strict().optional(),
    thinkingLevel: z.string().min(1).max(128).optional(),
  }).strict().optional(),
}).strict()

const branchSessionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clone') }).strict(),
  z.object({ kind: z.literal('fork'), entryId: z.string().min(1).max(512), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
])

const projectCwdSchema = z.object({ cwd: z.string().trim().min(1).max(4_096) }).strict()

const historyQuerySchema = z.object({
  before: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()

const turnIndexQuerySchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()

const settingsSchema = runtimeSettingsSchema

type SessionResolution =
  | { kind: 'found'; session: PiSessionSummary }
  | { kind: 'missing' }
  | { kind: 'failed' }

function historyRevisionChanged(cause: unknown) {
  return cause instanceof PiSessionHistorySourceChangedError || cause instanceof Error && cause.name === 'PiSessionHistoryRevisionError'
}

async function resolveSession(sessionId: string): Promise<SessionResolution> {
  try {
    const session = (await listPiSessions()).find((candidate) => candidate.id === sessionId)
    return session ? { kind: 'found', session } : { kind: 'missing' }
  } catch {
    return { kind: 'failed' }
  }
}

async function resolveWorkspace(cwd: string, projects: ProjectRegistry) {
  try {
    if ((await listPiSessions()).some((session) => session.cwd === cwd)) return 'native'
    return projects.has(cwd) ? 'registered' : false
  } catch {
    return undefined
  }
}

export function createSessionRoutes(runtime = new PiRuntimeRegistry(), projects = new ProjectRegistry(), security = new RuntimeSecurity()) {
  return new Hono()
    .get('/sessions', async (context) => {
      try {
        const sessions = await listPiSessions()

        return context.json({
          sessions: sessions.map(({ id, cwd, name, firstMessage, createdAt, updatedAt }) => ({ id, cwd, name, firstMessage: runtime.attachments.displayPrompt(firstMessage, id), createdAt, updatedAt })),
        } satisfies PiSessionsResponse)
      } catch {
        return context.json({ error: 'Failed to list Pi sessions' }, 500)
      }
    })
    .post('/sessions', async (context) => {
      const parsed = createSessionSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success || !parsed.data.prompt && !parsed.data.attachmentIds?.length) return context.json({ error: 'Invalid session creation request' }, 400)

      const workspace = await resolveWorkspace(parsed.data.cwd, projects)
      if (workspace === undefined) return context.json({ error: 'Failed to resolve Pi workspace' }, 500)
      if (!workspace) return context.json({ error: 'Pi workspace not found' }, 404)
      if (workspace === 'registered' && (!security.acceptsOrigin(context.req.header('origin')) || !security.acceptsToken(context.req.header('x-pi-nest-token')))) return context.json({ error: '项目访问被拒绝' }, 403)

      const input = { message: parsed.data.prompt, ...(parsed.data.attachmentIds ? { attachmentIds: parsed.data.attachmentIds, submissionId: parsed.data.submissionId } : {}) }
      const draftScope = `draft:${parsed.data.draftId}:${parsed.data.cwd}`
      if ((input.attachmentIds?.length || parsed.data.initialSettings) && (!security.acceptsOrigin(context.req.header('origin')) || !security.acceptsToken(context.req.header('x-pi-nest-token')))) return context.json({ error: '会话创建访问被拒绝' }, 403)
      let created: ReturnType<typeof createPiSession> | undefined
      let busy = false
      try {
        if (input.attachmentIds?.length) await runtime.attachments.prepare(draftScope, input)
        const result = await runtime.attachments.deliver(draftScope, input, async () => {
          created = createPiSession(parsed.data.cwd)
          runtime.attachments.transfer(input, draftScope, created.id)
          const prompt = runtime.beginPrompt(created, parsed.data.prompt || '请查看附件。', input.attachmentIds?.length ? input : undefined, parsed.data.initialSettings)
          if (!prompt) {
            busy = true
            throw new Error('Pi runtime is busy')
          }
          await prompt.accepted
          return {
            session: {
              createdAt: created.createdAt,
              cwd: created.cwd,
              firstMessage: parsed.data.prompt.replace(/\s+/g, ' ').trim() || '附件对话',
              id: created.id,
              updatedAt: new Date().toISOString(),
            },
          }
        })
        return context.json(result, 201)
      } catch (cause) {
        const uncertainSessionId = runtime.attachments.uncertainSession(draftScope, input)
        if (uncertainSessionId) return context.json({ error: '输入状态待确认，会话已保留，请查看历史后再决定是否重试。', code: 'SUBMISSION_UNKNOWN', sessionId: uncertainSessionId }, 409)
        if (created) {
          await runtime.deleteSession(created.id).catch(() => undefined)
          await deletePiSession({ expectedCwd: created.cwd, expectedSessionId: created.id, sessionFile: created.sessionFile }).catch(() => undefined)
        }
        if (cause instanceof AttachmentError) return context.json({ error: cause.message, code: cause.code }, cause.status)
        if (!busy) console.error('Failed to initialize Pi session', { cause })
        return context.json(
          busy
            ? { error: 'Pi runtime is busy' }
            : { code: 'SESSION_INITIALIZATION_FAILED', error: 'Failed to initialize Pi session' },
          busy ? 409 : 500,
        )
      }
    })
    .post('/sessions/:sessionId/branch', async (context) => {
      const parsed = branchSessionSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: 'Invalid branch request' }, 400)
      const resolved = await resolveSession(context.req.param('sessionId'))
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)
      if (!resolved.session.cwd) return context.json({ error: 'Pi session cwd is unavailable' }, 409)
      const revision = parsed.data.kind === 'fork' ? parsed.data.revision : undefined
      let beforeShutdown: Buffer | undefined
      const mutation = runtime.beginMutation(resolved.session.id, revision ? () => {
        beforeShutdown = readPiSessionForkSource({ sessionFile: resolved.session.sessionFile, revision })
      } : undefined)
      if (!mutation) return context.json({ error: 'Pi session is busy', code: 'SESSION_RUNNING' }, 409)
      let finish: (() => void) | undefined
      try {
        finish = await mutation
        // shortcut: Naming uses discovered sessions; add project locking if strict concurrent uniqueness is required.
        const naming = parsed.data.kind === 'clone' ? {
          existingNames: (await listPiSessions()).filter((candidate) => candidate.cwd === resolved.session.cwd)
            .map((candidate) => candidate.name ?? runtime.attachments.displayPrompt(candidate.firstMessage, candidate.id) ?? '未命名会话'),
          fallbackName: runtime.attachments.displayPrompt(resolved.session.firstMessage, resolved.session.id) ?? '未命名会话',
        } : {}
        const { session, draft, draftContent, entries } = branchPiSession({ ...parsed.data, ...naming, expectedSessionId: resolved.session.id, expectedCwd: resolved.session.cwd, sessionFile: resolved.session.sessionFile }, beforeShutdown)
        const { id, cwd, createdAt, name, firstMessage } = session
        runtime.attachments.inherit(entries, resolved.session.id, id)
        let attachments: import('@pi-nest/contracts').AttachmentRef[] | undefined
        let draftText = draft
        if (draftContent) {
          runtime.attachments.inherit(draftContent, resolved.session.id, id)
          const projected = runtime.attachments.project({ role: 'user', content: draftContent }, id)
          if (Array.isArray(projected.content)) {
            attachments = projected.content.flatMap((block: any) => block.attachment ? [block.attachment] : [])
            draftText = projected.content.flatMap((block: any) => block.type === 'text' ? [block.text] : []).join('')
          }
        }
        return context.json({ session: { id, cwd, createdAt, updatedAt: createdAt, name, firstMessage: runtime.attachments.displayPrompt(firstMessage, id) }, draft: draftText, ...(attachments?.length ? { attachments } : {}) }, 201)
      } catch (cause) {
        if (historyRevisionChanged(cause)) return context.json({ error: '会话历史已变化，请点击“刷新位置”后重新选择分叉消息。', code: 'HISTORY_REVISION_CHANGED' }, 409)
        if (cause instanceof PiSessionBranchTargetError) return context.json({ error: cause.message, code: 'INVALID_BRANCH_TARGET' }, 400)
        console.error('Failed to branch Pi session', { cause })
        return context.json({ error: '创建分支会话失败，请重试。' }, 500)
      } finally { finish?.() }
    })
    .post('/projects/reveal', async (context) => {
      const parsed = projectCwdSchema.safeParse(await context.req.json().catch(() => undefined))
      if (!parsed.success) return context.json({ error: 'Invalid Pi workspace request' }, 400)
      const workspace = await resolveWorkspace(parsed.data.cwd, projects)
      if (workspace === undefined) return context.json({ error: 'Failed to resolve Pi workspace' }, 500)
      if (!workspace) return context.json({ error: 'Pi workspace not found' }, 404)
      if (workspace === 'registered' && (!security.acceptsOrigin(context.req.header('origin')) || !security.acceptsToken(context.req.header('x-pi-nest-token')))) return context.json({ error: '项目访问被拒绝' }, 403)
      try {
        await revealPiWorkspace(parsed.data.cwd)
        return context.body(null, 204)
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (code === 'PROJECT_FOLDER_UNAVAILABLE') return context.json({ error: '项目文件夹不存在或该路径不是文件夹。', code }, 404)
        if (code === 'PROJECT_FOLDER_ACCESS_DENIED') return context.json({ error: '没有访问项目文件夹的权限。', code }, 403)
        if (code === 'PROJECT_FOLDER_UNSUPPORTED') return context.json({ error: '当前系统不支持打开项目文件夹。', code }, 501)
        return context.json({ error: '无法启动系统文件管理器，请确认当前系统支持桌面操作。', code: 'PROJECT_FOLDER_OPEN_FAILED' }, 500)
      }
    })
    .get('/sessions/:sessionId/history', async (context) => {
      const sessionId = context.req.param('sessionId')
      const query = historyQuerySchema.safeParse(context.req.query())
      if (!query.success) return context.json({ error: 'Invalid history page request' }, 400)

      const resolved = await resolveSession(sessionId)
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)
      if (!resolved.session.cwd) return context.json({ error: 'Pi session cwd is unavailable', code: 'CWD_UNAVAILABLE' }, 409)

      try {
        const history = runtime.history.history(resolved.session, {
          ...(query.data.before === undefined ? {} : { before: query.data.before }),
          ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
          ...(query.data.revision === undefined ? {} : { revision: query.data.revision }),
        })
        context.header('Cache-Control', 'no-store')
        return context.json({
          ...runtime.attachments.project(history, sessionId),
          session: { id: resolved.session.id, cwd: resolved.session.cwd, updatedAt: resolved.session.updatedAt },
        } satisfies PiSessionHistoryResponse)
      } catch (cause) {
        if (cause instanceof PiSessionHistoryCursorError) return context.json({ error: 'Invalid history page request' }, 400)
        if (cause instanceof HistorySnapshotExpired) return context.json({ error: 'History snapshot expired', code: 'HISTORY_SNAPSHOT_EXPIRED' }, 409)
        if (historyRevisionChanged(cause)) {
          return context.json({ error: 'Pi session changed while reading history', code: 'REVISION_CHANGED' }, 409)
        }
        return context.json({ error: 'Failed to read Pi session history' }, 500)
      }
    })
    .get('/sessions/:sessionId/turn-index', async (context) => {
      const sessionId = context.req.param('sessionId')
      const query = turnIndexQuerySchema.safeParse(context.req.query())
      if (!query.success) return context.json({ error: 'Invalid Turn index request' }, 400)

      const resolved = await resolveSession(sessionId)
      if (resolved.kind === 'failed') return context.json({ error: 'Failed to resolve Pi session' }, 500)
      if (resolved.kind === 'missing') return context.json({ error: 'Pi session not found' }, 404)
      if (!resolved.session.cwd) return context.json({ error: 'Pi session cwd is unavailable', code: 'CWD_UNAVAILABLE' }, 409)

      try {
        const turnIndex = runtime.history.index(resolved.session, query.data.revision)
        context.header('Cache-Control', 'no-store')
        return context.json({ ...turnIndex, entries: turnIndex.entries.map((entry) => ({ ...entry, promptPreview: runtime.attachments.displayPrompt(entry.promptPreview, sessionId) ?? '' })) })
      } catch (cause) {
        if (cause instanceof HistorySnapshotExpired) return context.json({ error: 'History snapshot expired', code: 'HISTORY_SNAPSHOT_EXPIRED' }, 409)
        if (historyRevisionChanged(cause)) return context.json({ error: 'Pi session changed while reading history', code: 'REVISION_CHANGED' }, 409)
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
        return context.json({ settings })
      } catch {
        return context.json({ error: 'Failed to save Pi settings' }, 500)
      } finally {
        await finish(true)
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
