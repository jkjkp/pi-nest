import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { AttachmentStore } from '../dist/attachment-store.js'

function chunk(name, body) {
  const data = Buffer.concat([Buffer.from(name), body])
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const output = Buffer.alloc(body.length + 12)
  output.writeUInt32BE(body.length)
  data.copy(output, 4)
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4)
  return output
}

function png() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(256)
  header.writeUInt32BE(256, 4)
  header[8] = 8
  header[9] = 6
  const rows = Buffer.alloc(256 * 1025)
  for (let y = 0; y < 256; y++) randomBytes(1024).copy(rows, y * 1025 + 1)
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const directory = mkdtempSync(join(tmpdir(), 'pi-attachment-perf-'))
const store = new AttachmentStore(directory)
try {
  const start = performance.now()
  const refs = []
  for (let i = 0; i < 8; i++) {
    const bytes = png()
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
    refs.push(await store.upload(stream, 'perf', `${i}.png`, 'image/png'))
  }
  const prepared = await store.prepare('perf', {
    message: 'eight images', attachmentIds: refs.map((ref) => ref.id), submissionId: randomUUID(),
  })
  assert.equal(prepared.images.length, 8)
  const raw = Array.from({ length: 100 }, (_, index) => ({ role: 'user', content: [prepared.images[index % 8]] }))
  const rawBytes = Buffer.byteLength(JSON.stringify(raw))
  const projected = store.project(raw, 'perf')
  assert(projected.every((message) => message.content.every((block) => !('data' in block) && block.attachment)))
  console.log(JSON.stringify({
    fixture: '8 independently generated 256x256 RGBA PNGs; 100 history image blocks',
    uploadBytes: refs.reduce((sum, ref) => sum + ref.size, 0),
    rpcImageBase64Bytes: prepared.images.reduce((sum, image) => sum + image.data.length, 0),
    historyRawBytes: rawBytes,
    historyProjectedBytes: Buffer.byteLength(JSON.stringify(projected)),
    elapsedMs: Math.round(performance.now() - start),
    processMaxRSSKiB: process.resourceUsage().maxRSS,
  }, null, 2))
} finally {
  rmSync(directory, { recursive: true, force: true })
}
