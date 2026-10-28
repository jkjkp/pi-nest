import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'

import { listPiSessions } from './index.js'
import { sessionFirstMessage } from './session-files.js'

const CREATED = '2026-09-19T08:00:00.000Z'
const FIRST = Date.parse('2026-09-19T09:00:00.000Z')
const SECOND = Date.parse('2026-09-19T10:00:00.000Z')
const THIRD = Date.parse('2026-09-19T11:00:00.000Z')
const CWD = '/work/project'

let directory: string
let sessionDirectory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pi-session-summary-'))
  sessionDirectory = join(directory, '--project--')
  mkdirSync(sessionDirectory)
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

type Entry = Record<string, unknown>

function writeSession(file: string, entries: Array<Entry | string>) {
  writeFileSync(join(sessionDirectory, file), entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n')
}

function header(id: string, extra: Entry = {}) {
  return { type: 'session', version: 3, id, timestamp: CREATED, cwd: CWD, ...extra }
}

function message(id: string, role: 'user' | 'assistant', content: unknown, timestamp: number | undefined, parentId: unknown = null, entryTimestamp = CREATED) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: entryTimestamp,
    message: { role, content, ...(timestamp === undefined ? {} : { timestamp }) },
  }
}

function info(id: string, name: string, parentId: unknown = null) {
  return { type: 'session_info', id, parentId, timestamp: CREATED, name }
}

function expected(firstMessage: string) {
  return sessionFirstMessage(firstMessage)
}

describe('listPiSessions', () => {
  it('matches SessionManager.listAll() summary fields on fixed JSONL samples', async () => {
    writeSession('named.jsonl', [
      header('named'),
      message('u1', 'user', '  fix   the\n\nsidebar   title  ', FIRST),
      message('a1', 'assistant', 'done', SECOND, 'u1'),
      info('n1', ' First name ', 'a1'),
      info('n2', 'Latest name', 'n1'),
    ])
    writeSession('cleared.jsonl', [
      header('cleared'),
      message('u2', 'user', [{ type: 'text', text: 'alpha' }, { type: 'image', data: 'ignored' }, { type: 'text', text: 'beta' }], FIRST),
      info('n3', 'Visible', 'u2'),
      info('n4', '   ', 'n3'),
    ])
    writeSession('long.jsonl', [
      header('long'),
      message('u3', 'user', `${'🙂'.repeat(200)}`, FIRST),
    ])
    writeSession('empty.jsonl', [header('empty')])
    writeSession('malformed.jsonl', [
      header('malformed'),
      '{not valid json',
      message('u4', 'user', 'after malformed line', FIRST),
      message('a2', 'assistant', 'answer', SECOND, 'u4'),
    ])
    writeSession('late-header.jsonl', [
      'garbage before the header',
      header('late-header'),
      message('u5', 'user', 'still discovered', FIRST),
    ])
    writeSession('invalid-first.jsonl', [
      { type: 'custom', id: 'c1', timestamp: CREATED },
      header('invalid-first'),
      message('u6', 'user', 'must not be discovered', FIRST),
    ])
    writeSession('primitive-first.jsonl', [
      '5',
      header('primitive-first'),
      message('u11', 'user', 'must not be discovered', FIRST),
    ])
    writeSession('empty-first-user.jsonl', [
      header('empty-first-user'),
      message('u7', 'user', [], FIRST),
      message('u8', 'user', 'later user text', SECOND, 'u7'),
    ])
    writeSession('fallback-activity.jsonl', [
      header('fallback-activity'),
      message('u9', 'user', 'no message timestamp', undefined, null, new Date(THIRD).toISOString()),
    ])
    writeSession('parent.jsonl', [
      header('parent', { parentSession: join(sessionDirectory, 'named.jsonl') }),
      message('u10', 'user', 'child session', FIRST),
    ])

    const sdk = new Map((await SessionManager.listAll(sessionDirectory)).map((session) => [session.id, session]))
    const sessions = await listPiSessions(directory)
    const byId = new Map(sessions.map((session) => [session.id, session]))

    expect([...byId.keys()].sort()).toEqual([...sdk.keys()].sort())
    for (const [id, expectedSession] of sdk) {
      expect(byId.get(id)).toEqual({
        id,
        cwd: expectedSession.cwd || undefined,
        sessionFile: expectedSession.path,
        name: expectedSession.name || undefined,
        firstMessage: expected(expectedSession.firstMessage),
        createdAt: expectedSession.created.toISOString(),
        updatedAt: expectedSession.modified.toISOString(),
        parentSessionPath: expectedSession.parentSessionPath,
      })
    }
    expect(byId.get('named')?.firstMessage).toBe('fix the sidebar title')
    expect(Array.from(byId.get('long')?.firstMessage ?? '')).toHaveLength(121)
    expect(byId.get('long')?.firstMessage?.endsWith('…')).toBe(true)
    expect(byId.get('cleared')?.name).toBeUndefined()
    expect(byId.get('empty')?.firstMessage).toBeUndefined()
    expect(byId.get('empty')?.updatedAt).toBe(CREATED)
    expect(byId.get('empty-first-user')?.firstMessage).toBe('later user text')
    expect(byId.get('fallback-activity')?.updatedAt).toBe(new Date(THIRD).toISOString())
    expect(byId.get('parent')?.parentSessionPath).toBe(join(sessionDirectory, 'named.jsonl'))
    expect(byId.has('invalid-first')).toBe(false)
    expect(byId.has('primitive-first')).toBe(false)
    const times = sessions.map((session) => Date.parse(session.updatedAt ?? ''))
    expect(times).toEqual([...times].sort((left, right) => right - left))
  })

  it('sorts by the last user or assistant activity time, not by file mtime', async () => {
    writeSession('older.jsonl', [header('older'), message('u1', 'user', 'older', FIRST)])
    writeSession('newer.jsonl', [header('newer'), message('u2', 'user', 'newer', SECOND)])
    // Make the older session's file mtime newer than the newer session's content.
    writeFileSync(join(sessionDirectory, 'older.jsonl'), `${JSON.stringify(header('older'))}\n${JSON.stringify(message('u1', 'user', 'older', FIRST))}\n`)

    const sessions = await listPiSessions(directory)

    expect(sessions.map((session) => session.id)).toEqual(['newer', 'older'])
  })

  it('returns an empty list when the session directory does not exist', async () => {
    await expect(listPiSessions(join(directory, 'missing'))).resolves.toEqual([])
  })
})
