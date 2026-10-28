import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AttachmentStore } from './attachment-store.js'
import { SessionInputQueue } from './session-input-queue.js'

let directory: string
let attachments: AttachmentStore
let queue: SessionInputQueue
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pi-input-queue-'))
  attachments = new AttachmentStore(directory)
  queue = new SessionInputQueue('session', attachments)
})
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

async function enqueue(id: string, message = 'same') {
  await queue.enqueue({ submissionId: id, message }, 'unused.jsonl', async () => undefined)
}

it('keeps legacy indices relative to the native queue and gives input IDs precedence', async () => {
  await enqueue('first')
  await enqueue('second')
  queue.setNativeQueue([], ['native one', 'native two'])

  expect(queue.selectForSteering({ index: 2, message: 'same' }).id).toBe('first')
  expect(queue.selectForSteering({ index: '3', message: 'same' }).id).toBe('second')
  expect(queue.selectForSteering({ inputId: 'second', index: 2, message: 'same' }).id).toBe('second')
  for (const command of [
    { index: 1, message: 'same' },
    { index: 4, message: 'same' },
    { inputId: 'missing', index: 2, message: 'same' },
    { inputId: 'first', message: 'changed' },
  ]) expect(() => queue.selectForSteering(command)).toThrow('Queued message has already changed')
  expect(queue.snapshot().followUp).toEqual(['native one', 'native two', 'same', 'same'])
})

it('invalidates replaced records by identity even when their ID and text are unchanged', async () => {
  await enqueue('first')
  await enqueue('second')
  const selected = queue.nextForDelivery()!
  const second = queue.selectForDrop('second')
  expect(queue.contains(selected)).toBe(true)
  expect(queue.isHead(selected)).toBe(true)
  expect(queue.isHead(second)).toBe(false)

  expect(queue.reject(selected, new Error('unavailable'))).toBe(true)
  const replacement = queue.selectForRecovery('first')
  expect(replacement.id).toBe(selected.id)
  expect(replacement.message).toBe(selected.message)
  expect(replacement).not.toBe(selected)
  expect(queue.contains(selected)).toBe(false)
  expect(queue.isHead(selected)).toBe(false)
  expect(queue.contains(replacement)).toBe(true)
  expect(queue.isHead(replacement)).toBe(true)
  expect(queue.reject(selected, new Error('stale'))).toBe(false)
  expect(queue.selectForRecovery('first').error).toBe('unavailable')
})

it('does not skip a recovery-required head or allow recovery of a live input', async () => {
  await enqueue('first')
  await enqueue('second')
  expect(() => queue.selectForRecovery('first')).toThrow(expect.objectContaining({ message: '待确认消息已变化。', status: 409 }))
  queue.reject(queue.nextForDelivery()!, new Error('unavailable'))
  expect(queue.nextForDelivery()).toBeUndefined()
  queue.retire(queue.selectForDrop('first'))
  expect(queue.nextForDelivery()?.id).toBe('second')
  expect(() => queue.selectForDrop('first')).toThrow(expect.objectContaining({ message: '排队消息已变化，请刷新后重试。', status: 409 }))
})

it('keeps steering receipts on admission and retires only the chosen receipt on recovery', async () => {
  await enqueue('first')
  await enqueue('second')
  attachments.steering('session', [{ id: 'first', message: 'same' }, { id: 'second', message: 'same' }])
  queue.acknowledge(queue.nextForDelivery()!)
  expect(attachments.queue('session').map((input) => input.id)).toEqual(['second'])
  expect(attachments.steering('session').map((input) => input.id)).toEqual(['first', 'second'])

  const restored = new SessionInputQueue('session', attachments)
  const dropped = restored.retire(restored.selectForDrop('second'))
  expect(dropped?.id).toBe('second')
  expect(attachments.queue('session').map((input) => input.id)).toEqual(['first'])
  expect(attachments.steering('session').map((input) => input.id)).toEqual(['first'])
})

it('persists failure recovery once and invalidates pre-failure selections', async () => {
  const save = vi.spyOn(attachments, 'queue')
  expect(queue.recoverAfterFailure()).toBe(false)
  expect(save).not.toHaveBeenCalled()
  await enqueue('first')
  const selected = queue.nextForDelivery()!
  attachments.steering('session', [{ id: 'first', message: 'same' }, { id: 'second', message: 'steering' }])
  save.mockClear()

  expect(queue.recoverAfterFailure()).toBe(true)
  expect(save).toHaveBeenCalledTimes(1)
  expect(attachments.queue('session')).toEqual([
    { id: 'first', message: 'same', recoveryRequired: true },
    { id: 'second', message: 'steering', recoveryRequired: true },
  ])
  expect(queue.contains(selected)).toBe(false)
  expect(queue.nextForDelivery()).toBeUndefined()
})

it('persists the queue before publishing and preserves the existing rollback on publish failure', async () => {
  const failure = new Error('publish failed')
  await expect(queue.enqueue({ submissionId: 'first', message: 'same' }, 'unused.jsonl', async () => {
    expect(attachments.queue('session').map((input) => input.id)).toEqual(['first'])
    throw failure
  })).rejects.toBe(failure)
  expect(queue.snapshot().followUp).toEqual([])
  expect(attachments.queue('session').map((input) => input.id)).toEqual(['first'])
})
