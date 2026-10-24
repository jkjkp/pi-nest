import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { branchPiSession, readPiSessionForkSource, PiSessionBranchTargetError } from './branch-session.js'
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
  expect(child.getSessionName()).toBe('Original（副本）')
  expect(result.session.name).toBe(child.getSessionName())
  expect(result.draft).toBe('')
  expect(statSync(result.session.sessionFile).mode & 0o777).toBe(0o600)
  expect(readFileSync(source.getSessionFile()!)).toEqual(original)
  child.appendMessage({ role: 'user', content: 'child only', timestamp: Date.now() })
  expect(SessionManager.open(result.session.sessionFile).getBranch()).toHaveLength(child.getBranch().length)
  expect(readFileSync(source.getSessionFile()!)).toEqual(original)
})

it.each([
  { name: '登录接口排查', existingNames: [], expected: '登录接口排查（副本）' },
  { name: '登录接口排查', existingNames: ['登录接口排查（副本）', '登录接口排查（副本 2）'], expected: '登录接口排查（副本 3）' },
  { name: '登录接口排查（副本）', existingNames: [], expected: '登录接口排查（副本 2）' },
  { name: '登录接口排查（副本 2）', existingNames: ['登录接口排查（副本）'], expected: '登录接口排查（副本 3）' },
  { name: undefined, existingNames: [], expected: 'first question（副本）' },
])('persists the clone title $expected without renaming the source', async ({ name, existingNames, expected }) => {
  prompt('first\n question')
  if (name) source.appendSessionInfo(name)
  const original = readFileSync(source.getSessionFile()!)
  const result = branchPiSession({ ...options(), kind: 'clone', existingNames })
  expect(result.session.name).toBe(expected)
  expect(SessionManager.open(result.session.sessionFile).getSessionName()).toBe(expected)
  expect((await SessionManager.list(directory, join(directory, 'sessions'))).find((item) => item.id === result.session.id)?.name).toBe(expected)
  expect(readFileSync(source.getSessionFile()!)).toEqual(original)
})

it('uses the safe display title for unnamed attachment conversations and falls back for textless input', () => {
  source.appendMessage({ role: 'user', content: [{ type: 'image', data: 'image-bytes', mimeType: 'image/png' }], timestamp: Date.now() })
  expect(branchPiSession({ ...options(), kind: 'clone' }).session.name).toBe('未命名会话（副本）')
  expect(branchPiSession({ ...options(), kind: 'clone', fallbackName: '附件对话' }).session.name).toBe('附件对话（副本）')
})

it('reserves suffix space for numbered long names without breaking emoji', () => {
  prompt('first')
  source.appendSessionInfo('😀'.repeat(60))
  const first = branchPiSession({ ...options(), kind: 'clone' })
  const second = branchPiSession({ ...options(), kind: 'clone', existingNames: [first.session.name!] })
  expect(first.session.name).toBe('😀'.repeat(58) + '（副本）')
  expect(second.session.name).toBe('😀'.repeat(57) + '（副本 2）')
  expect(second.session.name!.length).toBeLessThanOrEqual(120)
})

it('keeps fork titles unchanged and cleans up when clone naming fails', () => {
  source.appendSessionInfo('Original')
  const first = prompt('first')
  const second = prompt('second')
  const fork = branchPiSession({ ...options(), kind: 'fork', entryId: second })
  expect(fork.session.name).toBe('Original')
  expect(SessionManager.open(fork.session.sessionFile).getBranch().filter((entry) => entry.type === 'message').map((entry) => entry.id)).toEqual([first])
  const files = readdirSync(join(directory, 'sessions'))
  const bytes = readFileSync(source.getSessionFile()!)
  vi.spyOn(SessionManager.prototype, 'appendSessionInfo').mockImplementationOnce(() => { throw new Error('name write failed') })
  expect(() => branchPiSession({ ...options(), kind: 'clone' })).toThrow('name write failed')
  expect(readdirSync(join(directory, 'sessions'))).toEqual(files)
  expect(readFileSync(source.getSessionFile()!)).toEqual(bytes)
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
  expect((await SessionManager.list(directory, join(directory, 'sessions'))).find((info) => info.id === result.session.id)?.parentSessionPath).toBe(source.getSessionFile())
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

it.each(['clone', 'fork'] as const)('removes the new session if the source changes during %s creation', (kind) => {
  prompt('before')
  const entryId = prompt('source')
  const request = options()
  const files = readdirSync(join(directory, 'sessions'))
  const create = SessionManager.prototype.createBranchedSession
  vi.spyOn(SessionManager.prototype, 'createBranchedSession').mockImplementationOnce(function (this: SessionManager, leaf) {
    const file = create.call(this, leaf)
    appendFileSync(request.sessionFile, '\n')
    return file
  })
  expect(() => branchPiSession({ ...request, kind, entryId })).toThrow('changed while reading history')
  expect(readdirSync(join(directory, 'sessions'))).toEqual(files)
})

it('forks image-bearing native input into a complete draft while clone preserves its image bytes', () => {
  const content = [{ type: 'text' as const, text: 'look' }, { type: 'image' as const, data: 'image-bytes', mimeType: 'image/png' }]
  const id = source.appendMessage({ role: 'user', content, timestamp: Date.now() })
  const original = readFileSync(source.getSessionFile()!)
  const fork = branchPiSession({ ...options(), kind: 'fork', entryId: id })
  expect(fork.draftContent).toEqual(content)
  expect(fork.draft).toBe('look')
  expect(SessionManager.open(fork.session.sessionFile).getBranch()).toEqual([])
  const clone = branchPiSession({ ...options(), kind: 'clone' })
  expect(JSON.stringify(SessionManager.open(clone.session.sessionFile).getBranch())).toContain('image-bytes')
  expect(readFileSync(source.getSessionFile()!)).toEqual(original)
})


it('accepts chained SDK shutdown metadata without changing the fork draft or inherited context', () => {
  const first = prompt('first')
  const selected = prompt('draft')
  const request = { ...options(), kind: 'fork' as const, entryId: selected }
  const before = readPiSessionForkSource(request)
  source.appendSessionInfo('Shutdown name')
  source.appendCustomEntry('extension-state', { saved: true })
  const result = branchPiSession(request, before)
  expect(result.draft).toBe('draft')
  expect(SessionManager.open(result.session.sessionFile).getBranch().map((entry) => entry.id)).toEqual([first])
  expect(() => readPiSessionForkSource(request)).toThrow(PiSessionHistoryRevisionError)
})

it.each(['rewrite', 'duplicate', 'malformed', 'custom_message'])('rejects unsafe shutdown changes (%s)', (change) => {
  const selected = prompt('draft')
  const request = { ...options(), kind: 'fork' as const, entryId: selected }
  const before = readPiSessionForkSource(request)
  if (change === 'rewrite') writeFileSync(request.sessionFile, before.toString().replace('draft', 'other'))
  else appendFileSync(request.sessionFile, change === 'malformed' ? '{broken\n' : JSON.stringify({
    type: change === 'custom_message' ? 'custom_message' : 'custom',
    id: change === 'duplicate' ? selected : 'shutdown', parentId: selected,
    timestamp: new Date().toISOString(), customType: 'fixture', content: 'new context',
  }) + '\n')
  expect(() => branchPiSession(request, before)).toThrow(PiSessionHistoryRevisionError)
  expect(readdirSync(join(directory, 'sessions'))).toHaveLength(1)
})

it('branches after an assistant reply, retaining that reply but excluding later messages and drafts', () => {
  const first = prompt('question')
  const answer = source.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'answer' }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() })
  prompt('later question')
  const before = readFileSync(source.getSessionFile()!)
  const result = branchPiSession({ ...options(), kind: 'fork', entryId: answer })
  const child = SessionManager.open(result.session.sessionFile)
  expect(child.getBranch().map((entry) => entry.id)).toEqual([first, answer])
  expect(child.getHeader()?.parentSession).toBe(source.getSessionFile())
  expect(result.draft).toBe('')
  expect(result.draftContent).toBeUndefined()
  expect(readFileSync(source.getSessionFile()!)).toEqual(before)
  child.appendMessage({ role: 'user', content: 'continue in branch', timestamp: Date.now() })
  expect(child.getBranch()).toHaveLength(3)
})
