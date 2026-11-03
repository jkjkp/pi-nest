import { Hono } from 'hono'
import { z } from 'zod'
import { configurationSecurity } from './configuration-routes.js'
import type { RuntimeSecurity } from './runtime-security.js'
import type { PiRuntimeRegistry } from './pi-runtime-registry.js'
import type { SessionIndex } from './session-index.js'
import type { SessionBranchStore } from './session-branch-store.js'
import { resolveSessionLineage } from './session-lineage.js'
import { graphFamily } from './session-graph.js'
import { HistorySnapshotExpired } from './session-history-snapshots.js'

const querySchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/).optional(), offset: z.coerce.number().int().min(0).max(10_000_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict()
export function createSessionGraphRoutes(runtime: PiRuntimeRegistry, security: RuntimeSecurity, index: SessionIndex, branches: SessionBranchStore) {
  return new Hono().use('/sessions/:sessionId/graph', configurationSecurity(security)).use('/sessions/:sessionId/graph-turns', configurationSecurity(security))
    .get('/sessions/:sessionId/graph', async (context) => {
      try {
        const native = resolveSessionLineage(await index.list(), branches.relations())
        if (!native.some((session) => session.id === context.req.param('sessionId'))) return context.json({ error: '会话不存在' }, 404)
        const sessions = graphFamily(native, context.req.param('sessionId')).map(({ id, cwd, name, firstMessage, createdAt, updatedAt, parentSessionId, parentSessionMissing, branch }) => ({ id, cwd, name, firstMessage: runtime.attachments.displayPrompt(firstMessage, id), createdAt, updatedAt, parentSessionId, parentSessionMissing, branch }))
        return context.json({ sessions, branchStorage: { available: branches.health.available } })
      } catch { return context.json({ error: '读取关联会话失败' }, 500) }
    })
    .get('/sessions/:sessionId/graph-turns', async (context) => {
      const parsed = querySchema.safeParse(context.req.query())
      if (!parsed.success || parsed.data.offset > 0 && !parsed.data.revision) return context.json({ error: '轮次分页参数无效' }, 400)
      try {
        const session = await index.resolve(context.req.param('sessionId'))
        if (!session?.cwd) return context.json({ error: '会话不可用' }, 404)
        const relation = branches.relations().get(session.id)
        const page = runtime.history.graph(session, relation?.cwd === session.cwd ? relation : undefined, parsed.data.revision, parsed.data.offset, parsed.data.limit, (text) => runtime.attachments.displayPrompt(text, session.id) ?? '')
        return context.json(page)
      } catch (cause) {
        if (cause instanceof HistorySnapshotExpired) return context.json({ error: '轮次图版本已过期，请刷新分支。', code: 'HISTORY_SNAPSHOT_EXPIRED' }, 409)
        return context.json({ error: '读取轮次图失败' }, 500)
      }
    })
}
