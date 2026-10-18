import { resizeImage } from '@earendil-works/pi-coding-agent'

export type PiInputImage = { type: 'image'; data: string; mimeType: string }

/** Decode using Pi's own worker before admitting a batch; failed images must not become text-only prompts. */
export async function preparePiImage(bytes: Uint8Array, mimeType: string, maxEdge = 2000) {
  const image = await resizeImage(bytes, mimeType, { maxWidth: maxEdge, maxHeight: maxEdge, maxBytes: 2 * 1024 * 1024 })
  if (!image) throw new Error('图片无法解码或压缩，请换一张图片。')
  return { image: { type: 'image' as const, data: image.data, mimeType: image.mimeType }, width: image.width, height: image.height }
}
