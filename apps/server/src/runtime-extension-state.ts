import type { PiRuntimeEvent, PiRuntimeExtensionUi } from '@pi-nest/contracts'
import { ProjectionSidecarStore, type ExtensionUiProjectionData } from './projection-sidecar-store.js'

type ExtensionUiProjection = { freshness: 'known' | 'restored'; statuses: Map<string, string>; widgets: Map<string, string[]> }

/** Owns extension projections and dialogs; runtime coordination stays in the Registry. */
export class RuntimeExtensionState {
  private readonly projections = new Map<string, ExtensionUiProjection>()
  private readonly dialogs = new Map<string, Map<string, PiRuntimeEvent>>()
  readonly ready: Promise<void>

  constructor(private readonly sidecars: ProjectionSidecarStore) {
    this.ready = this.restore()
  }

  trackDialog(sessionId: string, dialog: PiRuntimeEvent) {
    const event = dialog.event
    if (event.type !== 'extension_ui_request' || typeof event.id !== 'string') return false
    if (event.method !== 'select' && event.method !== 'confirm' && event.method !== 'input' && event.method !== 'editor') return false
    const pending = this.dialogs.get(sessionId) ?? new Map<string, PiRuntimeEvent>()
    pending.set(event.id, dialog)
    this.dialogs.set(sessionId, pending)
    return true
  }

  hasDialogs(sessionId: string) {
    return this.dialogs.has(sessionId)
  }

  pendingDialogs(sessionId: string) {
    return [...(this.dialogs.get(sessionId)?.values() ?? [])]
  }

  takeDialog(sessionId: string, id: string) {
    const pending = this.dialogs.get(sessionId)
    const dialog = pending?.get(id)
    if (!pending || !dialog) return undefined
    pending.delete(id)
    return { restore: () => { pending.set(id, dialog) } }
  }

  clearDialogs(sessionId: string) {
    const pending = this.dialogs.get(sessionId)
    this.dialogs.delete(sessionId)
    return [...(pending?.keys() ?? [])]
  }

  forget(sessionId: string) {
    this.projections.delete(sessionId)
    this.dialogs.delete(sessionId)
  }

  close() {
    this.projections.clear()
    this.dialogs.clear()
  }

  snapshot(sessionId: string): PiRuntimeExtensionUi {
    const extensionUi = this.projections.get(sessionId)
    return extensionUi
      ? {
          freshness: extensionUi.freshness,
          statuses: Object.fromEntries(extensionUi.statuses),
          widgets: Object.fromEntries([...extensionUi.widgets].map(([key, lines]) => [key, [...lines]])),
        }
      : { freshness: 'unknown', statuses: {}, widgets: {} }
  }

  private async restore() {
    for (const [sessionId, saved] of await this.sidecars.loadAll()) {
      if (!this.projections.has(sessionId)) this.projections.set(sessionId, { freshness: 'restored', statuses: new Map(Object.entries(saved.statuses)), widgets: new Map(Object.entries(saved.widgets).map(([key, lines]) => [key, [...lines]])) })
    }
  }

  async clearProjection(sessionId: string) {
    this.projections.set(sessionId, { freshness: 'known', statuses: new Map(), widgets: new Map() })
    await this.sidecars.delete(sessionId)
  }

  async trackProjection(sessionId: string, event: Record<string, unknown>) {
    const type = event.type === 'extension_ui_request' ? event.method : event.type
    if (type === 'setStatus') {
      const key = event.statusKey
      if (typeof key !== 'string' || !key) return
      const projection = this.projections.get(sessionId) ?? { freshness: 'known' as const, statuses: new Map(), widgets: new Map() }
      this.projections.set(sessionId, projection)
      projection.freshness = 'known'
      if (typeof event.statusText === 'string') projection.statuses.set(key, event.statusText)
      else projection.statuses.delete(key)
      await this.persistExtensionUi(sessionId, projection)
      return
    }
    if (type !== 'setWidget') return
    const key = event.widgetKey
    if (typeof key !== 'string' || !key) return
    const projection = this.projections.get(sessionId) ?? { freshness: 'known' as const, statuses: new Map(), widgets: new Map() }
    this.projections.set(sessionId, projection)
    projection.freshness = 'known'
    if (Array.isArray(event.widgetLines) && event.widgetLines.every((line) => typeof line === 'string')) projection.widgets.set(key, [...event.widgetLines])
    else projection.widgets.delete(key)
    await this.persistExtensionUi(sessionId, projection)
  }

  private async persistExtensionUi(sessionId: string, value: ExtensionUiProjection) {
    const projection: ExtensionUiProjectionData = {
      statuses: Object.fromEntries(value.statuses),
      widgets: Object.fromEntries([...value.widgets].map(([key, lines]) => [key, [...lines]])),
    }
    await this.sidecars.save(sessionId, projection)
  }
}
