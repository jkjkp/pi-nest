import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AttachmentStore } from './attachment-store.js'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, openSync: vi.fn(fs.openSync), fsyncSync: vi.fn(fs.fsyncSync), writeFileSync: vi.fn(fs.writeFileSync), rmSync: vi.fn(fs.rmSync) }
})
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open), rm: vi.fn(fs.rm) }
})

let directory: string
let store: AttachmentStore
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const stream = (bytes: Buffer) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } })

beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs')
  const asyncFs = await vi.importActual<typeof promises>('node:fs/promises')
  const readOnly = new Set<number>()
  vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
    const fd = actual.openSync(path, flags, mode)
    if (flags === 'r') readOnly.add(fd)
    else readOnly.delete(fd)
    return fd
  })
  // Simulate Windows FlushFileBuffers rejecting a handle without write access.
  vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
    if (readOnly.has(fd)) throw Object.assign(new Error('Flush requires write access'), { code: 'EPERM', syscall: 'fsync' })
    actual.fsyncSync(fd)
  })
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync)
  vi.mocked(fs.rmSync).mockImplementation(actual.rmSync)
  vi.mocked(promises.open).mockImplementation(asyncFs.open)
  vi.mocked(promises.rm).mockImplementation(asyncFs.rm)
  directory = fs.mkdtempSync(join(tmpdir(), 'pi-windows-attachments-'))
  store = new AttachmentStore(directory)
})
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it.each(['image', 'file'])('persists %s data and receipts under Windows flush rules', async (kind) => {
  const bytes = kind === 'image' ? png : Buffer.from('file contents')
  const ref = await store.upload(stream(bytes), 'session', kind === 'image' ? '截图.png' : '说明.txt', kind === 'image' ? 'image/png' : 'text/plain')
  const input = { message: '', attachmentIds: [ref.id], submissionId: randomUUID() }
  await store.prepare('session', input)
  await store.deliver('session', input, async () => ({ accepted: true }))
  if (kind === 'image') expect((await store.thumbnail(store.read(ref.id, 'session'))).mimeType).toBe('image/png')
  const restored = new AttachmentStore(directory)
  expect(restored.read(ref.id, 'session').bytes).toEqual(bytes)
  expect(restored.receipt('session', input)).toEqual({ accepted: true })
  expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.anything(), { flag: 'wx', mode: 0o600, flush: true })
  expect(fs.readdirSync(directory).filter((name) => name.startsWith('tmp-'))).toEqual([])
})

it.each([0, 1])('does not return a receipt when durable write %s fails and permits a new upload', async (successfulWrites) => {
  const actual = await vi.importActual<typeof fs>('node:fs')
  const cause = Object.assign(new Error('disk failure'), { code: 'EIO', syscall: 'fsync' })
  if (successfulWrites) vi.mocked(fs.writeFileSync).mockImplementationOnce(actual.writeFileSync)
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw cause })
  await expect(store.upload(stream(Buffer.from('hello')), 'session', 'file.txt', 'text/plain')).rejects.toBe(cause)
  expect(fs.readdirSync(directory).some((name) => /^(meta|input|tmp)-/.test(name))).toBe(false)
  const ref = await store.upload(stream(Buffer.from('hello')), 'session', 'file.txt', 'text/plain')
  expect(store.read(ref.id, 'session').bytes.toString()).toBe('hello')
})

it.each(['close', 'remove'])('closes before removal and preserves the upload error when %s also fails', async (failure) => {
  const actual = await vi.importActual<typeof promises>('node:fs/promises')
  const original = new Error('upload disconnected')
  const cleanup = Object.assign(new Error('cleanup denied'), { code: 'EPERM' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let closed = false
  vi.mocked(promises.open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args)
    const close = file.close.bind(file)
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close()
      closed = true
      if (failure === 'close') throw cleanup
    })
    return file
  })
  vi.mocked(promises.rm).mockImplementationOnce(async (path, options) => {
    expect(closed).toBe(true)
    if (failure === 'remove') throw cleanup
    await actual.rm(path, options)
  })
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('partial')) }, pull(c) { c.error(original) } })
  await expect(store.upload(body, 'session', 'file.txt', 'text/plain')).rejects.toBe(original)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('attachment temporary file'), { cause: cleanup })
  expect(fs.readdirSync(directory).some((name) => /^(data|meta)-/.test(name))).toBe(false)
})

it('preserves a durable-write failure when synchronous temporary-file cleanup also fails', async () => {
  const cause = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  const cleanup = Object.assign(new Error('cleanup denied'), { code: 'EPERM' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw cause })
  vi.mocked(fs.rmSync).mockImplementationOnce(() => { throw cleanup })
  await expect(store.upload(stream(Buffer.from('hello')), 'session', 'file.txt', 'text/plain')).rejects.toBe(cause)
  expect(log).toHaveBeenCalledWith('Failed to remove attachment temporary file', { cause: cleanup })
})
