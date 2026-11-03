import { createHash } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, linkSync, openSync, unlinkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { PiSessionMutationOptions, PiCreatedSession } from './manage-session.js'
import { PiSessionHistoryRevisionError, PiSessionHistorySourceChangedError } from './read-session-history.js'

export class PiSessionBranchTargetError extends Error {}
export type PiPreparedBranch = { childSessionId: string; sourceEntryId: string | null; inheritedLeafId: string | null; inheritedHash: string; sourceRevision: string; mode: 'edit' | 'continue' | 'clone'; createdAt: string }
export type PiSessionBranchOptions = PiSessionMutationOptions & { onPrepared?: (branch: PiPreparedBranch) => void; onPublished?: () => void } & ({ kind: 'clone'; existingNames?: string[]; fallbackName?: string } | { kind: 'fork'; mode?: 'edit' | 'continue'; entryId: string; revision: string })
export type PiSessionBranchResult = { session: PiCreatedSession & { name?: string; firstMessage?: string }; draft: string; draftContent?: unknown; entries?: unknown; lineage: PiPreparedBranch }

export function branchPrefixHash(entries: { id: string }[], leaf: string | null): string {
  if (leaf === null) return createHash('sha256').update('[]').digest('hex')
  const end = entries.findIndex((entry) => entry.id === leaf)
  if (end < 0) throw new PiSessionBranchTargetError('继承边界不在当前路径。')
  return createHash('sha256').update(JSON.stringify(entries.slice(0, end + 1))).digest('hex')
}

export function canContinuePiTurn(entries: import('@earendil-works/pi-coding-agent').SessionEntry[], entryId: string) {
  const end = entries.findIndex((entry) => entry.id === entryId)
  const entry = entries[end]
  if (!entry || entry.type !== 'message' || entry.message.role !== 'assistant' || !['stop', 'length'].includes(entry.message.stopReason)) return false
  const nextUser = entries.findIndex((entry, index) => index > end && entry.type === 'message' && entry.message.role === 'user')
  if (entries.slice(end + 1, nextUser < 0 ? undefined : nextUser).some((entry) => entry.type === 'message')) return false
  const pending = new Set<string>()
  for (const entry of entries.slice(0, end + 1)) {
    if (entry.type !== 'message') continue
    if (entry.message.role === 'assistant') for (const block of entry.message.content) if (block.type === 'toolCall') pending.add(block.id)
    if (entry.message.role === 'toolResult') pending.delete(entry.message.toolCallId)
  }
  return pending.size === 0
}

function fingerprint(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex') }
export function readPiSessionForkSource(options: Pick<PiSessionMutationOptions, 'sessionFile'> & { revision: string }): Buffer {
  const bytes = readFileSync(options.sessionFile)
  if (fingerprint(bytes) !== options.revision) throw new PiSessionHistoryRevisionError()
  return bytes
}

function onlyAppendedMetadata(before: Buffer, after: Buffer): boolean {
  if (before.at(-1) !== 10 || !after.subarray(0, before.length).equals(before)) return false
  try {
    const entries = before.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
    const ids = new Set(entries.map((entry) => entry.id))
    let parentId = entries.at(-1)?.id
    for (const line of after.subarray(before.length).toString('utf8').trim().split('\n')) {
      const entry = JSON.parse(line)
      if (!entry || !['session_info', 'custom'].includes(entry.type) || typeof entry.id !== 'string' || ids.has(entry.id) || entry.parentId !== parentId) return false
      ids.add(entry.id)
      parentId = entry.id
    }
    return true
  } catch { return false }
}

function messageText(content: unknown) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
}

function cloneName(name: string, existingNames: string[]) {
  const base = name.replace(/（副本(?: \d+)?）$/, '').trim() || '未命名会话'
  const taken = new Set([name, ...existingNames])
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? '（副本）' : `（副本 ${number}）`
    // Keep the suffix within the rename limit without cutting a surrogate pair.
    const candidate = base.slice(0, 120 - suffix.length).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + suffix
    if (!taken.has(candidate)) return candidate
  }
}

// shortcut: File-level branching skips extension fork hooks; use an isolated runtime when those hooks are required.
export function branchPiSession(options: PiSessionBranchOptions, beforeShutdown?: Buffer): PiSessionBranchResult {
  const bytes = readFileSync(options.sessionFile)
  const revision = fingerprint(bytes)
  // Only shutdown metadata may advance a fork revision; keep exact byte checks for all other writes.
  if (options.kind === 'fork' && revision !== options.revision) {
    if (!beforeShutdown || fingerprint(beforeShutdown) !== options.revision || !onlyAppendedMetadata(beforeShutdown, bytes)) throw new PiSessionHistoryRevisionError()
  }
  const temporary = mkdtempSync(join(tmpdir(), 'pi-nest-branch-'))
  chmodSync(temporary, 0o700)
  const snapshot = join(temporary, 'source.jsonl')
  let manager: SessionManager | undefined
  let createdFile: string | undefined
  let committed = false
  try {
    writeFileSync(snapshot, bytes, { flag: 'wx', mode: 0o600 })
    manager = SessionManager.open(snapshot, temporary)
    if (manager.getSessionId() !== options.expectedSessionId || manager.getHeader()?.cwd !== options.expectedCwd) throw new Error('Pi session binding mismatch')
    const branch = manager.getBranch()
    let target = manager.getLeafId()
    let draft = ''
    let draftContent: unknown
    if (options.kind === 'fork') {
      const entry = branch.find((entry) => entry.id === options.entryId)
      if (!entry || entry.type !== 'message' || !['user', 'assistant'].includes(entry.message.role)) throw new PiSessionBranchTargetError('请选择当前分支的一条用户消息或助手回复。')
      if (options.mode === 'edit' && entry.message.role !== 'user' || options.mode === 'continue' && entry.message.role !== 'assistant' || entry.message.role === 'assistant' && !canContinuePiTurn(branch, entry.id)) throw new PiSessionBranchTargetError('请选择用户消息或已结束轮次的最终回复。')
      target = entry.message.role === 'assistant' ? entry.id : entry.parentId
      if (entry.message.role === 'assistant') {
        const position = branch.findIndex((candidate) => candidate.id === entry.id)
        const nextUser = branch.findIndex((candidate, index) => index > position && candidate.type === 'message' && candidate.message.role === 'user')
        target = branch.slice(position, nextUser < 0 ? undefined : nextUser).at(-1)!.id
      }
      if (entry.message.role === 'user') {
        draft = messageText(entry.message.content)
        draftContent = entry.message.content
      }
    } else if (!target || !branch.some((entry) => entry.type === 'message' && entry.message.role === 'user')) {
      throw new PiSessionBranchTargetError('当前会话没有可复制的对话。')
    }
    const firstUser = branch.find((entry) => entry.type === 'message' && entry.message.role === 'user')
    const name = manager.getSessionName() || (options.kind === 'clone' ? options.fallbackName : undefined) ||
      (firstUser?.type === 'message' && firstUser.message.role === 'user' ? messageText(firstUser.message.content).replace(/\s+/g, ' ').trim() : '') || '未命名会话'
    if (target) manager.createBranchedSession(target)
    else manager.newSession({ parentSession: options.sessionFile })
    const header = manager.getHeader()
    const file = manager.getSessionFile()
    if (!header || !file || file === snapshot || manager.getSessionId() === options.expectedSessionId) throw new Error('Pi branch creation failed')
    if (options.kind === 'clone') manager.appendSessionInfo(cloneName(name, options.existingNames ?? []))
    // Persist SDK-produced entries even for a fork before the first user message, and bind lineage to the real source.
    const entries = manager.getEntries()
    const lineage: PiPreparedBranch = { childSessionId: header.id, sourceEntryId: options.kind === 'fork' ? options.entryId : target ?? null,
      inheritedLeafId: target ?? null, inheritedHash: branchPrefixHash(entries, target ?? null), sourceRevision: revision,
      mode: options.kind === 'clone' ? 'clone' : draftContent !== undefined ? 'edit' : 'continue', createdAt: header.timestamp }
    options.onPrepared?.(lineage)
    if (fingerprint(readFileSync(options.sessionFile)) !== revision) throw new PiSessionHistorySourceChangedError()
    const targetFile = join(dirname(options.sessionFile), basename(file))
    const staging = `${targetFile}.preparing`
    const descriptor = openSync(staging, 'wx', 0o600)
    try {
      try { writeFileSync(descriptor, [{ ...header, parentSession: options.sessionFile }, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n'); fsyncSync(descriptor) }
      finally { closeSync(descriptor) }
      if (fingerprint(readFileSync(options.sessionFile)) !== revision) throw new PiSessionHistorySourceChangedError()
      linkSync(staging, targetFile)
      createdFile = targetFile
      committed = true
      options.onPublished?.()
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(targetFile), 'r')
        try { fsyncSync(directory) } finally { closeSync(directory) }
      }
    } finally { unlinkSync(staging) }
    const first = entries.find((entry) => entry.type === 'message' && entry.message.role === 'user')
    committed = true
    return {
      session: { id: header.id, cwd: header.cwd, createdAt: header.timestamp, sessionFile: targetFile, name: manager.getSessionName(), firstMessage: first?.type === 'message' && first.message.role === 'user' ? messageText(first.message.content).replace(/\s+/g, ' ').trim().slice(0, 120) || undefined : undefined },
      draft,
      ...(draftContent ? { draftContent } : {}),
      entries,
      lineage,
    }
  } finally {
    if (!committed && createdFile) rmSync(createdFile, { force: true })
    rmSync(temporary, { force: true, recursive: true })
  }
}
