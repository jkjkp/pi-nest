// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAttachmentDraft, useAttachmentStore } from './attachment-draft.js'
import { configurationRequest } from './workspace-api.js'

vi.mock('./workspace-api.js', () => ({ configurationRequest: vi.fn() }))
let root: Root
let container: HTMLDivElement
let draft: ReturnType<typeof useAttachmentDraft>
function Probe({ sessionId }: { sessionId: string }) { const current = useAttachmentDraft(sessionId); useLayoutEffect(() => { draft = current }); return null }
async function render(sessionId = 'a') { await act(async () => root.render(<Probe sessionId={sessionId} />)) }
const file = (name = 'x.txt') => new File(['file'], name, { type: 'text/plain' })
const receipt = (id = crypto.randomUUID()) => ({ id, name: 'x.txt', kind: 'file' as const, mediaType: 'application/octet-stream', size: 4 })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAttachmentStore.setState({ drafts: {}, draftIds: {}, submissions: {} })
  vi.mocked(configurationRequest).mockReset()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(() => root.unmount()); container.remove() })

it('uploads and keeps receipts isolated by session, preserving attachments added after a submitted snapshot', async () => {
  vi.mocked(configurationRequest).mockImplementation(async (path) => path.endsWith('/inspect') ? { attachments: [] } as never : { attachment: receipt() } as never)
  await render()
  await act(async () => draft.add([file()]))
  expect(draft.items[0]?.status).toBe('ready')
  const submitted = [...draft.items]
  const first = draft.submission('hello')!
  expect(draft.submission('hello')?.submissionId).toBe(first.submissionId)
  expect(draft.submission('changed')?.submissionId).not.toBe(first.submissionId)
  await act(async () => draft.add([file('next.txt')]))
  await act(() => draft.clear(submitted))
  expect(draft.items).toHaveLength(1)
  await render('b')
  expect(draft.items).toHaveLength(0)
  await render('a')
  expect(draft.items).toHaveLength(1)
  expect(JSON.stringify(localStorage.getItem('pi-nest-attachments-v1'))).not.toContain('objectURL')
})

it('cancels removal and ignores a late successful response', async () => {
  let release!: (value: unknown) => void
  let signal: AbortSignal | undefined
  vi.mocked(configurationRequest).mockImplementation((_path, options) => { signal = options?.signal as AbortSignal; return new Promise((resolve) => { release = resolve }) as never })
  await render()
  await act(() => draft.add([file()]))
  const id = draft.items[0]!.id
  await act(() => draft.remove(id))
  expect(signal?.aborted).toBe(true)
  await act(async () => release({ attachment: receipt() }))
  expect(draft.items).toEqual([])
})

it('limits active uploads to two and retries failures without losing their place', async () => {
  const releases: (() => void)[] = []
  let active = 0
  let maximum = 0
  vi.mocked(configurationRequest).mockImplementation(() => new Promise((resolve) => {
    active++; maximum = Math.max(maximum, active)
    releases.push(() => { active--; resolve({ attachment: receipt() } as never) })
  }))
  await render()
  await act(() => draft.add([file('1'), file('2'), file('3'), file('4')]))
  expect(active).toBe(2)
  while (releases.length) await act(async () => releases.shift()!())
  expect(maximum).toBe(2)
  expect(draft.items.every((item) => item.status === 'ready')).toBe(true)
  vi.mocked(configurationRequest).mockRejectedValueOnce(new Error('offline'))
  await act(async () => draft.add([file('retry')]))
  const failed = draft.items.at(-1)!
  expect(failed.status).toBe('failed')
  expect(() => draft.submission('text')).toThrow('上传')
  vi.mocked(configurationRequest).mockResolvedValueOnce({ attachment: receipt() })
  await act(async () => draft.retry(failed.id))
  expect(draft.items.at(-1)?.id).toBe(failed.id)
  expect(draft.items.at(-1)?.status).toBe('ready')
})
