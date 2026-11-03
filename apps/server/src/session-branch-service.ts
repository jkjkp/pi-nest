import { createHash } from 'node:crypto'
import { branchPiSession, branchPrefixHash, capturePiSessionHistory, readPiEditEntries, type PiPreparedBranch, type PiSessionBinding, type PiSessionBranchResult } from '@pi-nest/pi-adapter'
import type { PiBranchOperation, PiBranchRelation, PiSessionBranchRequest, PiSessionBranchResponse } from '@pi-nest/contracts'
import { SessionBranchStore, type BranchRecord } from './session-branch-store.js'
import type { SessionIndex } from './session-index.js'
import type { AttachmentStore } from './attachment-store.js'

export function branchRelation(row: BranchRecord): PiBranchRelation {
  return { operationId: row.operation_id, parentSessionId: row.parent_session_id, sourceEntryId: row.source_entry_id,
    inheritedLeafId: row.inherited_leaf_id, mode: row.fork_mode, state: row.state === 'failed' ? 'attention' : row.state }
}
export function branchRequestHash(parent: string, request: PiSessionBranchRequest) {
  return createHash('sha256').update(JSON.stringify([parent, request.kind, request.kind === 'fork' ? request.mode ?? null : null, request.kind === 'fork' ? request.entryId : null, request.kind === 'fork' ? request.revision : null])).digest('hex')
}
export class BranchOperationConflict extends Error {}
export class SessionBranchService {
  constructor(readonly store: SessionBranchStore, private readonly index: SessionIndex, private readonly attachments: AttachmentStore) {}
  private projectDraft(content: unknown, parent: string, child: string, inherit = true) {
    if (inherit) this.attachments.inherit(content, parent, child)
    const projected = this.attachments.project({ role: 'user', content }, child) as { content?: unknown }
    if (typeof projected.content === 'string') return { draft: projected.content }
    const blocks = Array.isArray(projected.content) ? projected.content as { type?: string; text?: string; attachment?: import('@pi-nest/contracts').AttachmentRef }[] : []
    return { draft: blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(''), attachments: blocks.flatMap((block) => block.attachment ? [block.attachment] : []) }
  }
  private result(created: PiSessionBranchResult, parent: string, operationId: string): PiSessionBranchResponse {
    const { id, cwd, createdAt, name, firstMessage } = created.session
    this.attachments.inherit(created.entries, parent, id)
    return { session: { id, cwd, createdAt, updatedAt: createdAt, name, parentSessionId: parent,
      firstMessage: this.attachments.displayPrompt(firstMessage, id), branch: branchRelation(this.store.operation(operationId)!) },
      operationId, ...(created.draftContent !== undefined ? this.projectDraft(created.draftContent, parent, id) : { draft: created.draft }) }
  }
  create(source: PiSessionBinding, request: PiSessionBranchRequest & { operationId: string }, beforeShutdown: Buffer | undefined, naming: { existingNames?: string[]; fallbackName?: string }) {
    let prepared: PiPreparedBranch | undefined
    let published = false
    try {
      const created = branchPiSession({ ...request, ...naming, sessionFile: source.sessionFile, expectedSessionId: source.id, expectedCwd: source.cwd,
        onPublished: () => { published = true },
        onPrepared: (value) => {
          this.store.prepare({ operation_id: request.operationId, request_hash: branchRequestHash(source.id, request), child_session_id: value.childSessionId,
            parent_session_id: source.id, source_entry_id: value.sourceEntryId, inherited_leaf_id: value.inheritedLeafId, inherited_hash: value.inheritedHash,
            fork_mode: value.mode, source_revision: value.sourceRevision, cwd: source.cwd!, created_at: value.createdAt, state: 'pending', error_code: null })
          prepared = value
        } }, beforeShutdown)
      published = true
      this.index.register(created.session, { ...created.session, firstMessage: created.session.firstMessage, name: created.session.name, updatedAt: created.session.createdAt, parentSessionPath: source.sessionFile })
      const result = this.result(created, source.id, request.operationId)
      this.store.setState(request.operationId, 'ready')
      result.session.branch!.state = 'ready'
      return result
    } catch (cause) {
      if (prepared && !published) this.store.setState(request.operationId, 'failed', 'BRANCH_NOT_PUBLISHED')
      if (published) return { operationId: request.operationId, state: 'pending' as const }
      throw cause
    }
  }
  async operation(parent: string, id: string, request?: PiSessionBranchRequest): Promise<PiBranchOperation | undefined> {
    const row = this.store.operation(id)
    if (!row) return
    if (row.parent_session_id !== parent || request && row.request_hash !== branchRequestHash(parent, request)) throw new BranchOperationConflict('分支操作标识已用于其他请求。')
    const status: PiBranchOperation = { operationId: id, state: row.state, ...(row.error_code ? { code: row.error_code } : {}) }
    if (row.state !== 'ready') return status
    const child = await this.index.resolve(row.child_session_id)
    if (!child || child.cwd !== row.cwd) return { ...status, state: 'attention', code: 'BRANCH_FILE_UNAVAILABLE' }
    const summary = this.index.cachedSummary(child.id)
    const result: PiSessionBranchResponse = { operationId: id, session: { id: child.id, cwd: child.cwd, name: summary?.name, firstMessage: this.attachments.displayPrompt(summary?.firstMessage, child.id), createdAt: row.created_at, updatedAt: summary?.updatedAt, parentSessionId: parent, branch: branchRelation(row) }, draft: '' }
    if (row.fork_mode === 'edit') {
      try {
        const source = await this.index.resolve(parent)
        if (!source || source.cwd !== row.cwd) throw new Error('source missing')
        const entry = readPiEditEntries(source.sessionFile).find((entry) => entry.id === row.source_entry_id)
        if (!entry || entry.type !== 'message' || entry.message.role !== 'user') throw new Error('source entry missing')
        Object.assign(result, this.projectDraft(entry.message.content, parent, child.id, false))
      } catch { result.draftRecoveryRequired = true }
    }
    status.result = result
    return status
  }
  async recover() {
    if (!this.store.health.available) return
    for (const row of this.store.pending()) {
      try {
        const child = await this.index.resolve(row.child_session_id)
        if (!child) { this.store.setState(row.operation_id, 'failed', 'BRANCH_NOT_PUBLISHED'); continue }
        if (child.cwd !== row.cwd) throw new Error('binding conflict')
        const snapshot = capturePiSessionHistory({ sessionFile: child.sessionFile, expectedSessionId: child.id, expectedCwd: row.cwd })
        if (branchPrefixHash(snapshot.entries, row.inherited_leaf_id) !== row.inherited_hash) throw new Error('inheritance conflict')
        this.attachments.inherit(snapshot.entries, row.parent_session_id, child.id)
        if (row.fork_mode === 'edit') {
          const parent = await this.index.resolve(row.parent_session_id)
          if (parent?.cwd === row.cwd) {
            const entry = readPiEditEntries(parent.sessionFile).find((entry) => entry.id === row.source_entry_id)
            if (entry?.type === 'message') this.attachments.inherit(entry.message, parent.id, child.id)
          }
        }
        this.store.setState(row.operation_id, 'ready')
      } catch (cause) {
        console.error('分支恢复需要检查', { operationId: row.operation_id, cause })
        this.store.setState(row.operation_id, 'attention', 'BRANCH_RECOVERY_CONFLICT')
      }
    }
  }
}
