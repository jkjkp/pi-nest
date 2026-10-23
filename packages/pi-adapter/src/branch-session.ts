import { createHash } from 'node:crypto'
import { chmodSync, closeSync, openSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { PiSessionMutationOptions, PiCreatedSession } from './manage-session.js'
import { PiSessionHistoryRevisionError, PiSessionHistorySourceChangedError } from './read-session-history.js'

export class PiSessionBranchTargetError extends Error {}
export type PiSessionBranchOptions = PiSessionMutationOptions & ({ kind: 'clone'; existingNames?: string[]; fallbackName?: string } | { kind: 'fork'; entryId: string; revision: string })
export type PiSessionBranchResult = { session: PiCreatedSession & { name?: string; firstMessage?: string }; draft: string; draftContent?: unknown; entries?: unknown }

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
      if (!entry || entry.type !== 'message' || entry.message.role !== 'user') throw new PiSessionBranchTargetError('请选择当前分支的一条用户消息。')
      target = entry.parentId
      draft = messageText(entry.message.content)
      draftContent = entry.message.content
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
    const targetFile = join(dirname(options.sessionFile), basename(file))
    const descriptor = openSync(targetFile, 'wx', 0o600)
    createdFile = targetFile
    try { writeFileSync(descriptor, [{ ...header, parentSession: options.sessionFile }, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n') }
    finally { closeSync(descriptor) }
    if (fingerprint(readFileSync(options.sessionFile)) !== revision) throw new PiSessionHistorySourceChangedError()
    const first = entries.find((entry) => entry.type === 'message' && entry.message.role === 'user')
    committed = true
    return {
      session: { id: header.id, cwd: header.cwd, createdAt: header.timestamp, sessionFile: targetFile, name: manager.getSessionName(), firstMessage: first?.type === 'message' && first.message.role === 'user' ? messageText(first.message.content).replace(/\s+/g, ' ').trim().slice(0, 120) || undefined : undefined },
      draft,
      ...(draftContent ? { draftContent } : {}),
      entries,
    }
  } finally {
    if (!committed && createdFile) rmSync(createdFile, { force: true })
    rmSync(temporary, { force: true, recursive: true })
  }
}
