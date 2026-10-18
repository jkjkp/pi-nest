import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AttachmentStore } from './attachment-store.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
let directory: string
let store: AttachmentStore
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'pi-attachment-store-')); store = new AttachmentStore(directory) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))
const stream = (bytes: Uint8Array | string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(typeof bytes === 'string' ? Buffer.from(bytes) : bytes); c.close() } })
const upload = (bytes = 'hello', scope = 'a') => store.upload(stream(bytes), scope, '测试.txt', 'text/plain')

it('stores private immutable bytes, verifies reads, and scopes opaque receipts', async () => {
  const ref = await upload()
  expect(store.read(ref.id, 'a').bytes.toString()).toBe('hello')
  expect(statSync(join(directory, `data-${ref.id}`)).mode & 0o777).toBe(0o600)
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  expect(() => store.read(ref.id, 'b')).toThrow('不属于')
  expect(() => store.read('../secret', 'a')).toThrow('标识')
  store.grant(ref.id, 'a', 'b')
  expect(store.read(ref.id, 'b').ref).toEqual(ref)
  writeFileSync(join(directory, `data-${ref.id}`), 'other')
  expect(() => store.read(ref.id, 'a')).toThrow('损坏')
})

it('does not commit interrupted, empty or oversized streams', async () => {
  const interrupted = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('partial')) }, pull(c) { c.error(new Error('disconnected')) } })
  await expect(store.upload(interrupted, 'a', 'x', '')).rejects.toThrow('disconnected')
  await expect(store.upload(stream(''), 'a', 'x', '')).rejects.toThrow('空')
  await expect(store.upload(stream(new Uint8Array(25 * 1024 * 1024 + 1)), 'a', 'x', '')).rejects.toThrow('25 MiB')
  expect(readdirSync(directory)).toEqual([])
})

it('decodes raster pixels, refuses MIME spoofing and damaged images, and keeps SVG as downloadable data', async () => {
  const bytes = Buffer.from(png, 'base64')
  const ref = await store.upload(stream(bytes), 'a', 'photo.png', 'image/png')
  expect(ref).toMatchObject({ kind: 'image', width: 1, height: 1 })
  await expect(store.upload(stream(bytes), 'a', 'photo.jpg', 'image/jpeg')).rejects.toThrow('不符')
  await expect(store.upload(stream(bytes.subarray(0, 35)), 'a', 'photo.png', 'image/png')).rejects.toThrow('解码')
  const svg = await store.upload(stream('<svg onload="alert(1)"/>'), 'a', 'x.svg', 'image/svg+xml')
  expect(svg.kind).toBe('file')
  expect(readdirSync(directory).filter((name) => name.startsWith('tmp-'))).toEqual([])
})

it('prepares ordered images and read-on-demand files, and rejects any invalid member as a whole batch', async () => {
  const file = await upload()
  const image = await store.upload(stream(Buffer.from(png, 'base64')), 'a', 'x.png', 'image/png')
  const input = { message: 'look', attachmentIds: [file.id, image.id], submissionId: randomUUID() }
  const prepared = await store.prepare('a', input)
  expect(prepared.images).toEqual([{ type: 'image', data: png, mimeType: 'image/png' }])
  expect(prepared.message).toContain(join(directory, `data-${file.id}`))
  await expect(store.prepare('b', input)).rejects.toThrow('不属于')
  await expect(store.prepare('a', { ...input, message: '/model' })).rejects.toThrow('命令')
  await expect(store.prepare('a', { ...input, attachmentIds: [file.id, randomUUID()], submissionId: randomUUID() })).rejects.toThrow('不属于')
  expect(() => store.read(image.id, 'a')).not.toThrow()
})

it('does not send a batch twice on duplicate or lost-ack retries, including concurrent retries', async () => {
  const ref = await upload()
  const input = { message: 'look', attachmentIds: [ref.id], submissionId: randomUUID() }
  await store.prepare('a', input)
  const send = vi.fn(async () => ({ runId: 'one' }))
  const [a, b] = await Promise.all([store.deliver('a', input, send), store.deliver('a', input, send)])
  expect(a).toEqual(b)
  expect(await new AttachmentStore(directory).deliver('a', input, send)).toEqual({ runId: 'one' })
  expect(send).toHaveBeenCalledTimes(1)
  await expect(store.deliver('a', input, send, undefined, 'steer')).rejects.toThrow('其他发送方式')
  await expect(store.prepare('a', { ...input, message: 'different' })).rejects.toThrow('其他内容')
})

it('keeps uncertain delivery blocked after restart rather than silently executing twice', async () => {
  const ref = await upload()
  const input = { message: 'look', attachmentIds: [ref.id], submissionId: randomUUID() }
  await store.prepare('a', input)
  await expect(store.deliver('a', input, async () => { throw new Error('Pi RPC connection closed') })).rejects.toThrow('connection')
  const retry = vi.fn()
  await expect(new AttachmentStore(directory).deliver('a', input, retry)).rejects.toThrow('尚未确认')
  expect(retry).not.toHaveBeenCalled()
})

it('projects native CLI images without base64 and lets the child retain verified file references', async () => {
  const file = await upload()
  const input = { message: 'look', attachmentIds: [file.id], submissionId: randomUUID() }
  const prepared = await store.prepare('a', input)
  const raw = { role: 'user', content: [{ type: 'text', text: prepared.message }, { type: 'image', data: png, mimeType: 'image/png' }] }
  const projected = store.project(raw, 'a') as any
  expect(projected.content[0].text).toBe('look')
  expect(projected.content[1].data).toBeUndefined()
  expect(projected.content[1].piNestProjection).toBe('attachment-reference')
  expect(projected.content[2].attachment.id).toBe(file.id)
  expect(JSON.stringify(raw)).toContain(png)
  expect(() => store.read(file.id, 'child')).toThrow('不属于')
  const child = store.inherit(raw, 'a', 'child') as any
  expect(child.content[2].attachment.id).toBe(file.id)
  expect(store.read(file.id, 'child').bytes.toString()).toBe('hello')
  expect(store.read(child.content[1].attachment.id, 'child').bytes.toString('base64')).toBe(png)
  const meta = join(directory, `input-${input.submissionId}`)
  expect(JSON.parse(readFileSync(meta, 'utf8')).scopes).toEqual(['a', 'child'])
})

it('does not trust a copied marker in a different session and rebuilds native image caches', async () => {
  const file = await upload()
  const input = { message: 'look', attachmentIds: [file.id], submissionId: randomUUID() }
  const prepared = await store.prepare('a', input)
  const projected = store.project({ role: 'user', content: [{ type: 'text', text: prepared.message }] }, 'b') as any
  expect(projected.content).toHaveLength(1)
  expect(projected.content[0].text).toContain('pi-nest-attachments')
  const native = { type: 'image', data: png, mimeType: 'image/png' }
  const first = store.project(native, 'a') as any
  rmSync(join(directory, `data-${first.attachment.id}`))
  store.project(native, 'a')
  expect(store.read(first.attachment.id, 'a').bytes.toString('base64')).toBe(png)
})

it('keeps the new-session scope after committing its draft delivery receipt', async () => {
  const draftScope = 'draft:test:/project'
  const ref = await upload('file', draftScope)
  const input = { message: '', attachmentIds: [ref.id], submissionId: randomUUID() }
  const prepared = await store.prepare(draftScope, input)
  await store.deliver(draftScope, input, async () => { store.transfer(input, draftScope, 'new-session'); return { session: { id: 'new-session' } } })
  const restored = new AttachmentStore(directory)
  const projected = restored.project({ role: 'user', content: [{ type: 'text', text: prepared.message }] }, 'new-session') as any
  expect(projected.content.at(-1).attachment.id).toBe(ref.id)
  expect(restored.displayPrompt(prepared.message.replace(/\s+/g, ' '), 'new-session')).toBe('请查看附件。')
})

it('checks thumbnail cache integrity and preserves quoted markers when projecting a new attachment input', async () => {
  const image = await store.upload(stream(Buffer.from(png, 'base64')), 'a', 'x.png', 'image/png')
  const thumbnail = await store.thumbnail(image.id, 'a')
  writeFileSync(join(directory, `thumb-${image.id}`), JSON.stringify({ ...thumbnail, data: 'corrupted' }))
  expect((await store.thumbnail(image.id, 'a')).data).toBe(png)
  const first = { message: 'first', attachmentIds: [image.id], submissionId: randomUUID() }
  const one = await store.prepare('a', first)
  const second = { message: `quoted: ${one.message}`, attachmentIds: [image.id], submissionId: randomUUID() }
  const two = await store.prepare('a', second)
  const projected = store.project({ role: 'user', content: [{ type: 'text', text: two.message }, { type: 'image', data: png, mimeType: 'image/png' }] }, 'a') as any
  expect(projected.content[0].text).toBe(second.message)
  expect(projected.content[1].attachment.name).toBe('x.png')
})
