import type { DragEvent } from 'react'
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AttachmentRef } from '@pi-nest/contracts'
import { configurationRequest } from './workspace-api.js'

export type AttachmentScope = { kind: 'session'; sessionId: string } | { kind: 'draft'; draftId: string; cwd: string }
export type DraftAttachment = { id: string; name: string; size: number; status: 'uploading' | 'ready' | 'failed'; ref?: AttachmentRef; error?: string }
type State = { drafts: Record<string, DraftAttachment[]>; draftIds: Record<string, string>; submissions: Record<string, { fingerprint: string; id: string }>; set: (key: string, items: DraftAttachment[]) => void }
const empty: DraftAttachment[] = []
const files = new Map<string, File>()
const controllers = new Map<string, AbortController>()
let uploading = 0
const waiting: (() => void)[] = []
export const useAttachmentStore = create<State>()(persist((set) => ({
  drafts: {}, draftIds: {}, submissions: {}, set: (key, items) => set((s) => ({ drafts: { ...s.drafts, [key]: items } })),
}), { name: 'pi-nest-attachments-v1', partialize: (s) => ({ draftIds: s.draftIds, submissions: s.submissions, drafts: Object.fromEntries(Object.entries(s.drafts).map(([key, items]) => [key, items.map((item) => item.status === 'ready' ? item : { ...item, status: 'failed', error: '上传未完成，请重新选择文件。' })])) }) }))

function draftId(cwd: string) {
  let id = useAttachmentStore.getState().draftIds[cwd]
  if (!id) { id = crypto.randomUUID(); useAttachmentStore.setState((s) => ({ draftIds: { ...s.draftIds, [cwd]: id } })) }
  return id
}
export function setDraftAttachments(sessionId: string, refs: AttachmentRef[]) {
  useAttachmentStore.getState().set(sessionId, refs.map((ref) => ({ id: ref.id, name: ref.name, size: ref.size, ref, status: 'ready' })))
}

export function useAttachmentDraft(sessionId: string, cwd?: string) {
  const scope = useMemo<AttachmentScope | undefined>(() => sessionId ? { kind: 'session', sessionId } : cwd ? { kind: 'draft', draftId: draftId(cwd), cwd } : undefined, [sessionId, cwd])
  const key = sessionId || (cwd ? `draft:${cwd}` : '')
  const items = useAttachmentStore((s) => s.drafts[key] ?? empty)
  useEffect(() => {
    if (!scope) return
    const restored = useAttachmentStore.getState().drafts[key] ?? []
    const ready = restored.filter((item) => item.status === 'ready' && item.ref)
    if (!ready.length) return
    const controller = new AbortController()
    void configurationRequest<{ attachments: AttachmentRef[] }>('/api/attachments/inspect', { method: 'POST', body: JSON.stringify({ scope, ids: ready.map((item) => item.ref!.id) }), signal: controller.signal }).catch(() => {
      if (!controller.signal.aborted) useAttachmentStore.getState().set(key, (useAttachmentStore.getState().drafts[key] ?? []).map((item) => ready.some((r) => r.id === item.id) ? { ...item, status: 'failed', error: '附件暂不可用，请重试或重新选择。' } : item))
    })
    return () => controller.abort()
    // Validate restored receipts on scope changes, not after each upload.
  }, [key, scope])

  const update = (id: string, change: Partial<DraftAttachment>) => useAttachmentStore.getState().set(key, (useAttachmentStore.getState().drafts[key] ?? []).map((item) => item.id === id ? { ...item, ...change } : item))
  async function upload(id: string) {
    const file = files.get(id)
    if (!scope) return
    if (!file) {
      const item = useAttachmentStore.getState().drafts[key]?.find((item) => item.id === id)
      if (item?.ref) {
        try { await configurationRequest('/api/attachments/inspect', { method: 'POST', body: JSON.stringify({ scope, ids: [item.ref.id] }) }); update(id, { status: 'ready', error: undefined }) }
        catch (cause) { update(id, { status: 'failed', error: cause instanceof Error ? cause.message : '请重新选择文件。' }) }
      } else update(id, { status: 'failed', error: '请重新选择文件。' })
      return
    }
    const controller = new AbortController()
    controllers.set(id, controller)
    update(id, { status: 'uploading', error: undefined })
    if (uploading >= 2) await new Promise<void>((resolve) => waiting.push(resolve))
    else uploading++
    try {
      controller.signal.throwIfAborted()
      const { attachment } = await configurationRequest<{ attachment: AttachmentRef }>('/api/attachments', {
        method: 'POST', signal: controller.signal, body: file, headers: { 'content-type': 'application/octet-stream', 'x-pi-nest-attachment-scope': encodeURIComponent(JSON.stringify(scope)), 'x-pi-nest-file-name': encodeURIComponent(file.name), 'x-pi-nest-file-type': file.type || 'application/octet-stream' },
      })
      if (!controller.signal.aborted) { update(id, { status: 'ready', ref: attachment }); files.delete(id) }
    } catch (cause) { if (!controller.signal.aborted) update(id, { status: 'failed', error: cause instanceof Error ? cause.message : '上传失败' }) }
    finally { const next = waiting.shift(); if (next) next(); else uploading--; controllers.delete(id) }
  }
  function add(selected: File[]) {
    if (!scope) return
    for (const file of selected) {
      const current = useAttachmentStore.getState().drafts[key] ?? []
      if (current.length >= 8) throw new Error('每次最多添加 8 个附件。')
      if (!file.size || file.size > (file.type.startsWith('image/') && file.type !== 'image/svg+xml' ? 10 : 25) * 1024 * 1024) throw new Error('文件为空或超出大小限制（图片 10 MiB，其他文件 25 MiB）。')
      if (current.reduce((n, item) => n + item.size, file.size) > 50 * 1024 * 1024) throw new Error('附件总大小不能超过 50 MiB。')
      const id = crypto.randomUUID()
      files.set(id, file)
      useAttachmentStore.getState().set(key, [...current, { id, name: file.name, size: file.size, status: 'uploading' }])
      void upload(id)
    }
  }
  function remove(id: string) {
    controllers.get(id)?.abort(); files.delete(id)
    useAttachmentStore.getState().set(key, (useAttachmentStore.getState().drafts[key] ?? []).filter((item) => item.id !== id))
  }
  function clear(accepted: DraftAttachment[]) { for (const item of accepted) remove(item.id) }
  function snapshot() {
    if (items.some((item) => item.status !== 'ready' || !item.ref)) throw new Error('请等待附件上传完成，或移除失败的附件。')
    return items.map((item) => item.ref!)
  }
  function submission(message: string) {
    const attachments = snapshot()
    if (!attachments.length) return undefined
    const fingerprint = JSON.stringify([message, attachments.map((a) => a.id)])
    const previous = useAttachmentStore.getState().submissions[key]
    const id = previous?.fingerprint === fingerprint ? previous.id : crypto.randomUUID()
    useAttachmentStore.setState((s) => ({ submissions: { ...s.submissions, [key]: { fingerprint, id } } }))
    return { attachments, attachmentIds: attachments.map((a) => a.id), submissionId: id }
  }
  return { submission, key, scope, items, add, remove, retry: upload, clear, snapshot, busy: items.some((item) => item.status !== 'ready') }
}

export function attachmentDrop(event: DragEvent, add: (files: File[]) => void) {
  if (!event.dataTransfer.types.includes('Files')) return
  event.preventDefault()
  if ([...event.dataTransfer.items].some((item) => item.webkitGetAsEntry?.()?.isDirectory)) throw new Error('暂不支持上传文件夹，请选择文件。')
  add([...event.dataTransfer.files])
}
