import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { editRecord, entryPath, pendingPiEdit, piEditRecoveryRecord, piEditStatus, sessionEditCommand, sessionEditType, type SessionEditRecord } from './session-edit.js'

export default function sessionEditExtension(pi: ExtensionAPI) {
  pi.registerCommand(sessionEditCommand, {
    description: 'Internal Pi Nest session control',
    async handler(args, ctx) {
      const input = JSON.parse(args)
      if (!input || !['prepare', 'recover'].includes(input.action)) throw new Error('Invalid session edit action')
      if (!ctx.isIdle()) throw new Error('Pi session is busy')
      const entries = ctx.sessionManager.getEntries()
      if (input.action === 'recover') {
        const record = piEditRecoveryRecord(entries, ctx.sessionManager.getLeafId())
        if (!record) return
        const result = await ctx.navigateTree(record.previousLeafId, { summarize: false })
        if (result.cancelled) throw new Error('Pi edit recovery was cancelled')
        pi.appendEntry(sessionEditType, { ...record, phase: 'rolled_back' })
        return
      }
      if (![input.submissionId, input.requestHash, input.entryId, input.revision, input.runId].every((value) => typeof value === 'string' && value.length > 0)) throw new Error('Invalid edit request')
      const existing = entries.find((entry) => editRecord(entry)?.submissionId === input.submissionId)
      if (existing) {
        if (editRecord(existing)!.requestHash !== input.requestHash) throw new Error('SUBMISSION_CONFLICT')
        if (piEditStatus(entries, input.submissionId).status === 'pending') throw new Error('EDIT_RECOVERY_REQUIRED')
        return
      }
      if (pendingPiEdit(entries)) throw new Error('EDIT_RECOVERY_REQUIRED')
      const file = ctx.sessionManager.getSessionFile()
      if (!file || createHash('sha256').update(readFileSync(file)).digest('hex') !== input.revision) throw new Error('HISTORY_REVISION_CHANGED')
      const leaf = ctx.sessionManager.getLeafId()
      const lastUser = entryPath(entries, leaf).findLast((entry) => entry.type === 'message' && entry.message.role === 'user')
      if (!leaf || lastUser?.id !== input.entryId) throw new Error('INVALID_EDIT_TARGET')
      const record: SessionEditRecord = { version: 1, submissionId: input.submissionId, requestHash: input.requestHash, targetEntryId: input.entryId, previousLeafId: leaf, runId: input.runId, phase: 'prepared' }
      pi.appendEntry(sessionEditType, record)
      const result = await ctx.navigateTree(input.entryId, { summarize: false })
      if (result.cancelled) { pi.appendEntry(sessionEditType, { ...record, phase: 'rolled_back' }); return }
      pi.appendEntry(sessionEditType, { ...record, phase: 'selected' })
    },
  })
}
