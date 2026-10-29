import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PiRuntimeEvent } from '@pi-nest/contracts'
import { ProjectionSidecarStore } from './projection-sidecar-store.js'
import { RuntimeExtensionState } from './runtime-extension-state.js'

const directories: string[] = []
async function state() {
  const directory = await mkdtemp(join(tmpdir(), 'pi-nest-extension-test-'))
  directories.push(directory)
  const extensions = new RuntimeExtensionState(new ProjectionSidecarStore({ directory }))
  await extensions.ready
  return { directory, extensions }
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

function dialog(id: string, sessionId = 'session-a'): PiRuntimeEvent {
  return { sessionId, sequence: 1, observedAt: 'now', event: { id, method: 'select', type: 'extension_ui_request' } }
}

describe('RuntimeExtensionState', () => {
  it('restores durable projections, isolates snapshots, and clears persisted state', async () => {
    const { directory, extensions } = await state()
    await extensions.trackProjection('session-a', { type: 'extension_ui_request', method: 'setStatus', statusKey: 'plan', statusText: 'planning' })
    await extensions.trackProjection('session-a', { type: 'setWidget', widgetKey: 'plan', widgetLines: ['one'] })
    const restored = new RuntimeExtensionState(new ProjectionSidecarStore({ directory }))
    await restored.ready
    const snapshot = restored.snapshot('session-a')
    expect(snapshot).toEqual({ freshness: 'restored', statuses: { plan: 'planning' }, widgets: { plan: ['one'] } })
    snapshot.statuses.plan = 'changed'
    snapshot.widgets.plan!.push('changed')
    expect(restored.snapshot('session-a')).toEqual({ freshness: 'restored', statuses: { plan: 'planning' }, widgets: { plan: ['one'] } })
    await restored.trackProjection('session-a', { type: 'setStatus', statusKey: 'plan', statusText: 'implementing' })
    expect(restored.snapshot('session-a').freshness).toBe('known')
    await restored.clearProjection('session-a')
    expect(restored.snapshot('session-a')).toEqual({ freshness: 'known', statuses: {}, widgets: {} })
    const cleared = new RuntimeExtensionState(new ProjectionSidecarStore({ directory }))
    await cleared.ready
    expect(cleared.snapshot('session-a')).toEqual({ freshness: 'unknown', statuses: {}, widgets: {} })
  })

  it('consumes dialogs once, restores failed responses, and returns IDs for bulk resolution', async () => {
    const { extensions } = await state()
    expect(extensions.trackDialog('session-a', dialog('one'))).toBe(true)
    extensions.trackDialog('session-a', dialog('two'))
    extensions.trackDialog('session-b', dialog('one', 'session-b'))
    const taken = extensions.takeDialog('session-a', 'one')
    expect(extensions.takeDialog('session-a', 'one')).toBeUndefined()
    expect(extensions.pendingDialogs('session-a').map((item) => item.event.id)).toEqual(['two'])
    taken!.restore()
    expect(extensions.clearDialogs('session-a')).toEqual(['two', 'one'])
    expect(extensions.pendingDialogs('session-a')).toEqual([])
    expect(extensions.pendingDialogs('session-b')).toHaveLength(1)
    taken!.restore()
    expect(extensions.pendingDialogs('session-a')).toEqual([])
    await extensions.close()
    expect(extensions.pendingDialogs('session-b')).toEqual([])
  })

  it('keeps event validation and deletion semantics', async () => {
    const { extensions } = await state()
    expect(extensions.trackDialog('session-a', { ...dialog('bad'), event: { type: 'extension_ui_request', id: 'bad', method: 'setStatus' } })).toBe(false)
    await extensions.trackProjection('session-a', { type: 'setWidget', widgetKey: 'plan', widgetLines: ['one'] })
    await extensions.trackProjection('session-a', { type: 'setWidget', widgetKey: '', widgetLines: ['ignored'] })
    expect(extensions.snapshot('session-a').widgets).toEqual({ plan: ['one'] })
    await extensions.trackProjection('session-a', { type: 'setWidget', widgetKey: 'plan', widgetLines: [42] })
    expect(extensions.snapshot('session-a').widgets).toEqual({})
    extensions.trackDialog('session-a', dialog('one'))
    extensions.forget('session-a')
    expect(extensions.snapshot('session-a').freshness).toBe('unknown')
    expect(extensions.pendingDialogs('session-a')).toEqual([])
  })
})


it('does not confirm another plugin cached status when a fresh plugin publishes', async () => {
  const { directory, extensions } = await state()
  await extensions.trackProjection('s', { type: 'setStatus', statusKey: 'ponytail', statusText: 'FULL' })
  const restored = new RuntimeExtensionState(new ProjectionSidecarStore({ directory }))
  await restored.ready
  await restored.trackProjection('s', { type: 'setStatus', statusKey: 'other', statusText: 'ready' })
  expect(restored.snapshot('s')).toEqual({ freshness: 'known', statuses: { other: 'ready' }, widgets: {} })
})
