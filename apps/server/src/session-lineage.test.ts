import { expect, it } from 'vitest'
import { resolveSessionLineage } from './session-lineage.js'

it('resolves only discovered same-project parent paths and preserves native summaries', () => {
  const session = (id: string, parentSessionPath?: string, cwd = '/work') => ({ id, sessionFile: `/sessions/${id}.jsonl`, parentSessionPath, cwd, name: undefined, firstMessage: undefined, updatedAt: undefined })
  const input = [session('a'), session('b', '/sessions/./a.jsonl'), session('c', '/sessions/b.jsonl'), session('gone', '/elsewhere/missing.jsonl'), session('self', '/sessions/self.jsonl'), session('cross', '/sessions/a.jsonl', '/other'), session('relative', 'a.jsonl')]
  const result = resolveSessionLineage(input)
  expect(result[0]).toEqual(input[0])
  expect(result[1].parentSessionId).toBe('a')
  expect(result[2].parentSessionId).toBe('b')
  for (const orphan of result.slice(3)) {
    expect(orphan.parentSessionId).toBeUndefined()
    expect(orphan.parentSessionMissing).toBe(true)
  }
  expect(input[1]).not.toHaveProperty('parentSessionId')
})
