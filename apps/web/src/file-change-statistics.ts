import type { PiFileChange } from '@pi-nest/contracts'

/** Native extension metadata is optional and must be validated like other tool output. */
export function fileChangeStatistics(value: unknown): PiFileChange | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const change = value as Record<string, unknown>
  if (change.version !== 1 || typeof change.path !== 'string' || !change.path || !Number.isSafeInteger(change.sequence) || (change.sequence as number) < 0) return
  const base = { version: 1 as const, path: change.path, sequence: change.sequence as number }
  if (Number.isSafeInteger(change.added) && (change.added as number) >= 0 && Number.isSafeInteger(change.removed) && (change.removed as number) >= 0 && ['created', 'deleted', 'modified', 'unchanged'].includes(change.changeType as string)) {
    return { ...base, added: change.added as number, removed: change.removed as number, changeType: change.changeType as 'created' | 'deleted' | 'modified' | 'unchanged' }
  }
  if (['binary', 'too_large', 'unreadable', 'unrecorded', 'diff_limit'].includes(change.reason as string)) return { ...base, reason: change.reason as 'binary' | 'too_large' | 'unreadable' | 'unrecorded' | 'diff_limit' }
}
