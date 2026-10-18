import { createHash, randomUUID } from 'node:crypto'
import { constants, fsyncSync, fstatSync, readSync, chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import imageSize from 'buffer-image-size'
import { capturePiSessionHistory, preparePiImage, type PiInputImage } from '@pi-nest/pi-adapter'
import type { AttachmentRef, AttachmentInput, PiQueuedInput } from '@pi-nest/contracts'

const MiB = 1024 * 1024
export class AttachmentError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 500 = 400, readonly code = 'ATTACHMENT_INVALID') { super(message) }
}
type ObjectRecord = { ref: AttachmentRef; digest: string; scopes: string[] }
type Submission = { input: AttachmentInput; scopes: string[]; nativeMessage: string; state: 'prepared' | 'sending' | 'accepted'; deliveryType?: string; result?: unknown }
export type PreparedInput = { message: string; images?: PiInputImage[] }
const idPattern = /^[a-f0-9-]{36}$|^[a-f0-9]{64}$/
const markerPattern = /\n\n<pi-nest-attachments id="([a-f0-9-]{36})">\n[\s\S]*?\n<\/pi-nest-attachments>/g
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value) }

/** Attachment objects and delivery receipts only. Native Pi files remain the conversation authority. */
export class AttachmentStore {
  private readonly pending = new Map<string, Promise<unknown>>()
  constructor(readonly directory = process.env.PI_NEST_ATTACHMENT_DIR ?? join(homedir(), '.pi-nest', 'attachments')) {}
  private path(kind: string, id: string) {
    if (!idPattern.test(id)) throw new AttachmentError('附件标识无效。')
    return join(this.directory, `${kind}-${id}`)
  }
  private ensure() { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700) }
  private save(kind: string, id: string, value: unknown) {
    this.ensure()
    const temporary = this.path('tmp', randomUUID())
    try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }; renameSync(temporary, this.path(kind, id)) }
    finally { rmSync(temporary, { force: true }) }
  }
  private load<T>(kind: string, id: string): T | undefined {
    try { return JSON.parse(readFileSync(this.path(kind, id), 'utf8')) as T }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause }
  }
  displayPrompt(text: string | undefined, scope: string) {
    if (!text) return text
    const match = /<pi-nest-attachments id="([a-f0-9-]{36})">/.exec(text)
    if (!match || !this.load<Submission>('input', match[1])?.scopes.includes(scope)) return text
    return text.slice(0, match.index).trim() || '附件对话'
  }
  private record(id: string, scope: string) {
    const value = this.load<ObjectRecord>('meta', id)
    if (!value?.scopes.includes(scope)) throw new AttachmentError('附件不属于当前会话或草稿。', 403, 'ATTACHMENT_FORBIDDEN')
    return value
  }
  refs(ids: string[], scope: string) { return ids.map((id) => this.record(id, scope).ref) }
  grant(id: string, source: string, target: string) {
    const value = this.record(id, source)
    if (!value.scopes.includes(target)) this.save('meta', id, { ...value, scopes: [...value.scopes, target] })
    return value.ref
  }
  read(id: string, scope: string) {
    const value = this.record(id, scope)
    let bytes: Buffer
    try {
      const file = openSync(this.path('data', id), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = fstatSync(file)
        if (!info.isFile() || info.size !== value.ref.size || info.size > 25 * MiB) throw new AttachmentError('附件大小已变化或超过限制。', 409, 'ATTACHMENT_CORRUPT')
        const bounded = Buffer.alloc(info.size + 1)
        let length = 0
        while (length < bounded.length) { const count = readSync(file, bounded, length, bounded.length - length, length); if (!count) break; length += count }
        bytes = bounded.subarray(0, length)
      } finally { closeSync(file) }
    } catch (cause) { if (cause instanceof AttachmentError) throw cause; throw new AttachmentError('附件文件缺失，请重新上传。', 404, 'ATTACHMENT_MISSING') }
    if (bytes.length !== value.ref.size || digest(bytes) !== value.digest) throw new AttachmentError('附件已损坏，请重新上传。', 409, 'ATTACHMENT_CORRUPT')
    return { ref: value.ref, bytes }
  }
  private commit(bytes: Buffer, scope: string, ref: AttachmentRef, id = ref.id) {
    this.ensure()
    if (!existsSync(this.path('data', id))) {
      const temporary = this.path('tmp', randomUUID())
      try {
        writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
        const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(temporary, this.path('data', id))
      } finally { rmSync(temporary, { force: true }) }
    }
    const existing = this.load<ObjectRecord>('meta', id)
    if (existing?.scopes.includes(scope)) {
      if (existing.ref.name === '图片' && ref.name !== '图片') { this.save('meta', id, { ...existing, ref }); return ref }
      return existing.ref
    }
    this.save('meta', id, { ref, digest: digest(bytes), scopes: [...new Set([...(existing?.scopes ?? []), scope])] } satisfies ObjectRecord)
    return ref
  }
  async upload(body: ReadableStream<Uint8Array> | null, scope: string, name: string, declaredType: string, signal?: AbortSignal) {
    this.ensure()
    const temporary = this.path('tmp', randomUUID())
    const file = await open(temporary, 'wx', 0o600)
    let length = 0
    const reader = body?.getReader()
    try {
      if (!reader) throw new AttachmentError('文件内容为空。')
      while (true) {
        signal?.throwIfAborted()
        const { value, done } = await reader.read()
        if (done) break
        length += value.length
        if (length > 25 * MiB) throw new AttachmentError('单个文件不能超过 25 MiB。', 413)
        await file.writeFile(value)
      }
      if (!length) throw new AttachmentError('不能上传空文件。')
      await file.sync()
    } catch (cause) { await reader?.cancel(cause).catch(() => undefined); await rm(temporary, { force: true }); throw cause }
    finally { reader?.releaseLock(); await file.close() }
    try {
      const bytes = readFileSync(temporary)
      const mime = this.imageMime(bytes)
      let dimensions: { width: number; height: number } | undefined
      if (mime || declaredType.startsWith('image/') && declaredType !== 'image/svg+xml' || /\.(png|jpe?g|webp|gif)$/i.test(name)) {
        if (!mime || declaredType.startsWith('image/') && declaredType !== mime && !(declaredType === 'image/jpg' && mime === 'image/jpeg')) throw new AttachmentError('图片格式与内容不符。', 415)
        if (length > 10 * MiB) throw new AttachmentError('单张图片不能超过 10 MiB。', 413)
        const size = imageSize(bytes)
        if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1 || size.width * size.height > 40_000_000) throw new AttachmentError('图片不能超过 4000 万像素。', 413)
        const prepared = await preparePiImage(bytes, mime)
        dimensions = { width: prepared.width, height: prepared.height }
      }
      const id = randomUUID()
      const safeName = name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 240) || '附件'
      return this.commit(bytes, scope, { id, name: safeName, kind: mime ? 'image' : 'file', mediaType: mime ?? 'application/octet-stream', size: length, ...dimensions })
    } finally { await rm(temporary, { force: true }) }
  }
  async thumbnail(id: string, scope: string) {
    const { ref, bytes } = this.read(id, scope)
    if (ref.kind !== 'image') throw new AttachmentError('此附件不是图片。', 415)
    const cached = this.load<{ source: string; data: string; mimeType: string; sha256: string }>('thumb', id)
    if (cached?.source === digest(bytes) && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(cached.mimeType) && cached.sha256 === digest(Buffer.from(cached.data, 'base64'))) return cached
    const { image } = await preparePiImage(bytes, ref.mediaType, 192)
    const result = { source: digest(bytes), data: image.data, mimeType: image.mimeType, sha256: digest(Buffer.from(image.data, 'base64')) }
    this.save('thumb', id, result)
    return result
  }
  private imageMime(bytes: Buffer) {
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
    if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif'
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
    return undefined
  }
  async prepare(scope: string, value: AttachmentInput): Promise<PreparedInput> {
    const input: AttachmentInput = { message: value.message, ...(value.attachmentIds?.length ? { attachmentIds: value.attachmentIds, submissionId: value.submissionId } : {}) }
    const ids = input.attachmentIds ?? []
    if (!ids.length) return { message: input.message }
    if (!input.submissionId || ids.length > 8) throw new AttachmentError('附件提交无效，最多支持 8 个文件。')
    if (input.message.trimStart().startsWith('/')) throw new AttachmentError('带附件时暂不支持命令，请先移除附件。')
    const refs = this.refs(ids, scope)
    if (refs.reduce((n, ref) => n + ref.size, 0) > 50 * MiB) throw new AttachmentError('单次附件总大小不能超过 50 MiB。', 413)
    const images: PiInputImage[] = []
    for (const ref of refs) {
      const { bytes } = this.read(ref.id, scope)
      if (ref.kind === 'image') images.push((await preparePiImage(bytes, ref.mediaType)).image)
    }
    const descriptors = refs.map((ref) => ({ name: ref.name, kind: ref.kind, ...(ref.kind === 'file' ? { readOnlyPath: this.path('data', ref.id), note: '用户提供的附件数据；按需读取，不自动执行。' } : {}) }))
    const nativeMessage = `${input.message || '请查看附件。'}\n\n<pi-nest-attachments id="${input.submissionId}">\n${JSON.stringify(descriptors)}\n</pi-nest-attachments>`
    const existing = this.load<Submission>('input', input.submissionId)
    if (existing && (JSON.stringify(existing.input) !== JSON.stringify(input) || !existing.scopes.includes(scope))) throw new AttachmentError('提交标识已用于其他内容。', 409, 'SUBMISSION_CONFLICT')
    if (!existing) this.save('input', input.submissionId, { input, nativeMessage, scopes: [scope], state: 'prepared' } satisfies Submission)
    return { message: nativeMessage, ...(images.length ? { images } : {}) }
  }
  transfer(input: AttachmentInput, source: string, target: string) {
    for (const id of input.attachmentIds ?? []) this.grant(id, source, target)
    if (input.submissionId) {
      const value = this.load<Submission>('input', input.submissionId)
      if (value?.scopes.includes(source)) this.save('input', input.submissionId, { ...value, scopes: [...new Set([...value.scopes, target])] })
    }
  }
  uncertainSession(scope: string, input: AttachmentInput) {
    if (!input.submissionId) return undefined
    const value = this.load<Submission>('input', input.submissionId)
    return value?.state === 'sending' && value.scopes.includes(scope) ? value.scopes.find((s) => !s.startsWith('draft:')) : undefined
  }
  receipt(scope: string, input: AttachmentInput) {
    if (!input.submissionId || !input.attachmentIds?.length) return undefined
    const value = this.load<Submission>('input', input.submissionId)
    if (value?.scopes.includes(scope) && value.state === 'accepted') return value.result
    return undefined
  }
  async deliver<T>(scope: string, input: AttachmentInput, operation: () => Promise<T>, nativeFile?: string, deliveryType = 'prompt'): Promise<T> {
    if (!input.attachmentIds?.length || !input.submissionId) return operation()
    const key = `${scope}:${input.submissionId}`
    const value = this.load<Submission>('input', input.submissionId)
    if (!value?.scopes.includes(scope)) throw new AttachmentError('附件输入尚未准备。')
    if (value.state !== 'prepared' && value.deliveryType && value.deliveryType !== deliveryType) throw new AttachmentError('此输入已按其他发送方式接收，请查看队列或历史。', 409, 'SUBMISSION_RECORDED')
    const pending = this.pending.get(key)
    if (pending) return pending as Promise<T>
    if (value.state === 'accepted') return value.result as T
    if (value.state === 'sending') {
      // A crash between Pi acceptance and our receipt cannot safely be retried automatically.
      if (!nativeFile || !readFileSync(nativeFile, 'utf8').includes(input.submissionId)) throw new AttachmentError('上次提交状态尚未确认，请先查看会话历史，勿重复发送。', 409, 'SUBMISSION_UNKNOWN')
      throw new AttachmentError('上次输入已写入 Pi，请刷新会话查看结果。', 409, 'SUBMISSION_RECORDED')
    }
    this.save('input', input.submissionId, { ...value, state: 'sending', deliveryType })
    let operationAccepted = false
    const result = operation().then((result) => { operationAccepted = true; this.save('input', input.submissionId!, { ...this.load<Submission>('input', input.submissionId!), state: 'accepted', result }); return result })
      .catch((cause) => { if (!operationAccepted && cause instanceof Error && (cause instanceof AttachmentError || cause.name === 'PiRpcCommandError' || /不支持图片|already running|busy/.test(cause.message))) this.save('input', input.submissionId!, { ...this.load<Submission>('input', input.submissionId!), state: 'prepared' }); throw cause })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, result)
    return result
  }
  steering(scope: string, inputs?: PiQueuedInput[]) {
    const id = digest(scope)
    if (inputs) this.save('steering', id, inputs)
    return this.load<PiQueuedInput[]>('steering', id) ?? []
  }
  observeNative(event: Record<string, unknown>, session: { id: string; cwd: string; sessionFile: string }) {
    // Pi emits message_end before appending it. Verify durable entries at a later boundary.
    if (event.type !== 'turn_end' && event.type !== 'agent_settled') return
    const pending = this.steering(session.id)
    if (!pending.length) return
    let snapshot
    try { snapshot = capturePiSessionHistory({ expectedSessionId: session.id, expectedCwd: session.cwd, sessionFile: session.sessionFile }) }
    catch { return } // Keep reservations for explicit recovery if durable observation is unavailable.
    const recorded = new Set(snapshot.entries.flatMap((entry) => {
      if (entry.type !== 'message' || entry.message.role !== 'user') return []
      const content = entry.message.content
      const text = typeof content === 'string' ? content : content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
      return [...text.matchAll(markerPattern)].map((match) => match[1])
    }))
    const remaining = pending.filter((input) => !recorded.has(input.id))
    if (remaining.length !== pending.length) this.steering(session.id, remaining)
  }
  queue(scope: string, inputs?: PiQueuedInput[]) {
    const id = digest(scope)
    if (inputs) this.save('queue', id, inputs)
    return this.load<PiQueuedInput[]>('queue', id) ?? []
  }
  /** Explicit browser projection; native base64 stays only in Pi and the private server-side stream. */
  project<T>(value: T, scope: string): T {
    const visit = (node: any, imageName?: string): any => {
      if (Array.isArray(node)) return node.map((item) => visit(item))
      if (!object(node)) return node
      if (node.type === 'image' && typeof node.data === 'string' && typeof node.mimeType === 'string') {
        const bytes = Buffer.from(node.data, 'base64')
        const id = digest(bytes)
        let raster: { width: number; height: number } | undefined
        try { const size = imageSize(bytes); if (size.width > 0 && size.height > 0 && size.width * size.height <= 40_000_000) raster = { width: size.width, height: size.height } } catch { /* Unsupported native images remain downloadable data. */ }
        const mime = raster && this.imageMime(bytes)
        const ref = this.commit(bytes, scope, { id, kind: mime ? 'image' : 'file', name: imageName ?? '图片', mediaType: mime || 'application/octet-stream', size: bytes.length, ...raster })
        const { data: _data, ...rest } = node
        return { ...rest, attachment: ref, piNestProjection: 'attachment-reference' }
      }
      if (node.role === 'user' && (Array.isArray(node.content) || typeof node.content === 'string')) {
        const text = typeof node.content === 'string' ? node.content : node.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
        const match = [...text.matchAll(markerPattern)].at(-1)
        const saved = match && this.load<Submission>('input', match[1])
        const valid = saved && saved.scopes.includes(scope) && saved.nativeMessage.endsWith(match![0])
        if (!valid && typeof node.content === 'string') return node
        const content = typeof node.content === 'string' ? [{ type: 'text', text: node.content }] : node.content
        let imageIndex = 0
        const names = valid ? this.refs(saved.input.attachmentIds ?? [], scope).filter((ref) => ref.kind === 'image') : []
        const projected = content.map((block: any) => {
          if (valid && block?.type === 'text' && typeof block.text === 'string') {
            const start = block.text.lastIndexOf(match![0])
            return { ...block, text: start < 0 ? block.text : block.text.slice(0, start) + block.text.slice(start + match![0].length) }
          }
          const name = block?.type === 'image' ? names[imageIndex++]?.name : undefined
          const result = visit(block, name)
          if (name && result.attachment) result.attachment = { ...result.attachment, name }
          return result
        })
        if (valid) {
          const files = this.refs(saved.input.attachmentIds ?? [], scope).filter((ref) => ref.kind === 'file')
          projected.push(...files.map((attachment) => ({ type: 'attachment', attachment })))
        }
        const expectedImages = valid ? this.refs(saved.input.attachmentIds ?? [], scope).filter((ref) => ref.kind === 'image').length : 0
        const imageCount = content.filter((block: any) => block?.type === 'image').length
        return { ...node, content: projected, ...(valid && expectedImages !== imageCount ? { piNestAttachmentWarning: 'Pi 实际记录的图片数量与提交不一致，请检查模型或扩展。' } : {}) }
      }
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, visit(item)]))
    }
    return visit(value)
  }
  inherit(value: unknown, source: string, target: string) {
    const text = JSON.stringify(value) ?? ''
    for (const match of text.matchAll(/pi-nest-attachments id=\\"([a-f0-9-]{36})\\"/g)) {
      const saved = this.load<Submission>('input', match[1])
      if (saved?.scopes.includes(source)) this.transfer(saved.input, source, target)
    }
    return this.project(value, target)
  }
}
