import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { branchPiSession, PiSessionBranchTargetError } from './branch-session.js'
import { PiSessionHistoryRevisionError } from './read-session-history.js'

let directory: string
let source: SessionManager
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'pi-nest-branch-test-')); source = SessionManager.create(directory, join(directory, 'sessions')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { force: true, recursive: true }) })
function prompt(text: string) { return source.appendMessage({ role: 'user', content: text, timestamp: Date.now() }) }
function options() {
  const sessionFile = source.getSessionFile()!
  return { sessionFile, expectedSessionId: source.getSessionId(), expectedCwd: directory, revision: createHash('sha256').update(readFileSync(sessionFile)).digest('hex') }
}
it('clones only the active native branch, preserves metadata and source bytes, and creates a usable distinct session', () => {
  const first = prompt('first')
  prompt('abandoned')
  source.branch(first)
  const last = prompt('active')
  source.appendSessionInfo('Original')
  const original = readFileSync(source.getSessionFile()!)
  const result = branchPiSession({ ...options(), kind: 'clone' })
  const child = SessionManager.open(result.session.sessionFile)
  expect(child.getSessionId()).not.toBe(source.getSessionId())
  expect(child.getHeader()?.parentSession).toBe(source.getSessionFile())
  expect(child.getBranch().filter((entry) => entry.type === 'message').map((entry) => entry.id)).toEqual([first, last])
  expect(child.getSessionName()).toBe('Original')
  expect(result.draft).toBe('')
  expect(statSync(result.session.sessionFile).mode & 0o777).toBe(0o600)
  expect(readFileSync(source.getSessionFile()!)).toEqual(original)
  child.appendMessage({ role: 'user', content: 'child only', timestamp: Date.now() })
  expect(SessionManager.open(result.session.sessionFile).getBranch()).toHaveLength(child.getBranch().length)
  expect(readFileSync(source.getSessionFile()!)).toEqual(original)
})
it('forks before a selected message and returns its complete text as an unsent draft', () => {
  const first = prompt('first')
  const selected = prompt('selected\nfull text')
  prompt('later')
  const result = branchPiSession({ ...options(), kind: 'fork', entryId: selected })
  const child = SessionManager.open(result.session.sessionFile)
  expect(child.getBranch().map((entry) => entry.id)).toEqual([first])
  expect(result.draft).toBe('selected\nfull text')
  expect(child.getHeader()?.parentSession).toBe(source.getSessionFile())
})
it('persists a fork before the first message even when no conversation entries remain', async () => {
  const first = prompt('first')
  const result = branchPiSession({ ...options(), kind: 'fork', entryId: first })
  expect(existsSync(result.session.sessionFile)).toBe(true)
  const child = SessionManager.open(result.session.sessionFile)
  expect(child.getBranch()).toEqual([])
  expect(child.getHeader()?.parentSession).toBe(source.getSessionFile())
  expect(result.draft).toBe('first')
  expect((await SessionManager.list(directory, join(directory, 'sessions'))).some((info) => info.id === result.session.id)).toBe(true)
})
it('preserves pre-conversation settings in a fork before the first user message', () => {
  const model = source.appendModelChange('fixture', 'test')
  const first = prompt('first')
  const result = branchPiSession({ ...options(), kind: 'fork', entryId: first })
  expect(SessionManager.open(result.session.sessionFile).getBranch().map((entry) => entry.id)).toEqual([model])
})
it('rejects stale history and targets outside the active branch without creating a session', () => {
  const first = prompt('first')
  const abandoned = prompt('abandoned')
  const old = options()
  source.branch(first)
  prompt('active')
  const files = readdirSync(join(directory, 'sessions'))
  expect(() => branchPiSession({ ...old, kind: 'fork', entryId: first })).toThrow(PiSessionHistoryRevisionError)
  expect(() => branchPiSession({ ...options(), kind: 'fork', entryId: abandoned })).toThrow(PiSessionBranchTargetError)
  expect(() => branchPiSession({ ...options(), expectedSessionId: 'wrong', kind: 'clone' })).toThrow('binding mismatch')
  expect(readdirSync(join(directory, 'sessions'))).toEqual(files)
})

it('removes the new session if the source changes during creation', () => {
  prompt('source')
  const request = options()
  const files = readdirSync(join(directory, 'sessions'))
  const create = SessionManager.prototype.createBranchedSession
  vi.spyOn(SessionManager.prototype, 'createBranchedSession').mockImplementationOnce(function (this: SessionManager, leaf) {
    const file = create.call(this, leaf)
    appendFileSync(request.sessionFile, '\n')
    return file
  })
  expect(() => branchPiSession({ ...request, kind: 'clone' })).toThrow('changed while reading history')
  expect(readdirSync(join(directory, 'sessions'))).toEqual(files)
})
