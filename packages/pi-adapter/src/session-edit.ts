import { readFileSync } from 'node:fs'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PiEditStatus } from '@pi-nest/contracts'

export const sessionEditCommand = '__pi_nest_edit'
export const sessionEditType = 'pi-nest-edit'
export type SessionEditRecord = {
  version: 1; submissionId: string; requestHash: string; targetEntryId: string; previousLeafId: string
  phase: 'prepared' | 'selected' | 'rolled_back'; runId: string
}

export function editRecord(entry: SessionEntry): SessionEditRecord | undefined {
  if (entry.type !== 'custom' || entry.customType !== sessionEditType) return
  const data = entry.data as Partial<SessionEditRecord> | undefined
  if (!data || data.version !== 1 || !['prepared', 'selected', 'rolled_back'].includes(data.phase ?? '') ||
    ![data.submissionId, data.requestHash, data.targetEntryId, data.previousLeafId, data.runId].every((value) => typeof value === 'string' && value.length > 0)) throw new Error('Invalid Pi edit recovery record')
  return data as SessionEditRecord
}

export function readPiEditEntries(file: string): SessionEntry[] {
  // A malformed complete frame must not be mistaken for an unsubmitted edit.
  const bytes = readFileSync(file, 'utf8')
  const end = bytes.lastIndexOf('\n')
  return bytes.slice(0, end + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type !== 'session')
}

export function entryPath(entries: SessionEntry[], leafId: string | null = entries.at(-1)?.id ?? null) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const path: SessionEntry[] = []
  const visited = new Set<string>()
  while (leafId) {
    const entry = byId.get(leafId)
    if (!entry || visited.has(leafId)) throw new Error('Pi session parent chain is invalid')
    visited.add(leafId); path.push(entry); leafId = entry.parentId
  }
  return path.reverse()
}

export function piEditStatus(entries: SessionEntry[], submissionId: string): PiEditStatus {
  const records = entries.filter((entry) => editRecord(entry)?.submissionId === submissionId)
  const last = records.at(-1)
  const data = last && editRecord(last)
  if (!last || !data) return { status: 'unknown', submissionId }
  if (data.phase === 'rolled_back') return { status: 'rolled_back', submissionId }
  const selected = records.findLast((entry) => editRecord(entry)?.phase === 'selected')
  if (!selected) return { status: 'pending', submissionId, runId: data.runId }
  const user = firstUserBelow(entries, selected.id)
  if (!user) return { status: 'pending', submissionId, runId: data.runId }
  const current = entryPath(entries).some((entry) => entry.id === user.id)
  return { status: current ? 'committed' : 'superseded', submissionId, userEntryId: user.id, runId: data.runId }
}

export function firstUserBelow(entries: SessionEntry[], entryId: string) {
  const descendants = new Set([entryId])
  return entries.slice(entries.findIndex((entry) => entry.id === entryId) + 1).find((entry) => {
    if (!entry.parentId || !descendants.has(entry.parentId)) return false
    descendants.add(entry.id)
    return entry.type === 'message' && entry.message.role === 'user'
  })
}

export function pendingPiEdit(entries: SessionEntry[]) {
  const entry = entries.findLast((entry) => editRecord(entry)?.phase === 'prepared')
  return entry && piEditStatus(entries, editRecord(entry)!.submissionId).status === 'pending' ? entry : undefined
}

export function piEditRecoveryRecord(entries: SessionEntry[], leafId?: string | null) {
  const pending = pendingPiEdit(entries)
  if (!pending) return
  const record = editRecord(pending)!
  if (!entryPath(entries, leafId).some((entry) => editRecord(entry)?.submissionId === record.submissionId)) throw new Error('EDIT_RECOVERY_REQUIRED: Session path changed outside this edit')
  if (!entries.some((entry) => editRecord(entry)?.submissionId === record.submissionId && editRecord(entry)?.phase === 'selected') && firstUserBelow(entries, pending.id)) throw new Error('EDIT_RECOVERY_REQUIRED: An unassociated user message must be preserved')
  return record
}

export function piEditBoundary(entries: SessionEntry[]) {
  return entries.findLast((entry) => { const data = editRecord(entry); return data && data.phase !== 'prepared' })?.id
}
