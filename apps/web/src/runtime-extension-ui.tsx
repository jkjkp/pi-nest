import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'

import { RuntimeWebSocketClient, type PiRuntimeEvent } from './runtime-websocket-client.js'
import { stripAnsiLine, stripAnsiText } from './ansi-text.js'
import { useWorkspaceStore } from './workspace-store.js'

type Dialog = { id: string; method: 'confirm' | 'editor' | 'input' | 'select'; sessionId: string; title: string; message?: string; options?: string[]; prefill?: string }

function dialogFrom(event: PiRuntimeEvent): Dialog | undefined {
  const value = event.event
  if (value.type !== 'extension_ui_request' || typeof value.id !== 'string' || typeof value.method !== 'string') return undefined
  if (value.method !== 'select' && value.method !== 'confirm' && value.method !== 'input' && value.method !== 'editor') return undefined
  return { id: value.id, method: value.method, sessionId: event.sessionId, title: typeof value.title === 'string' ? stripAnsiLine(value.title) : 'Pi extension request', message: typeof value.message === 'string' ? stripAnsiLine(value.message) : undefined, options: Array.isArray(value.options) ? value.options.filter((item): item is string => typeof item === 'string').map(stripAnsiLine) : undefined, prefill: typeof value.prefill === 'string' ? stripAnsiText(value.prefill) : undefined }
}

/** Native extension UI bridge. Unsupported TUI-only requests remain visible in the timeline. */
export function RuntimeExtensionUi({ runtime }: { runtime: RuntimeWebSocketClient }) {
  const [dialogs, setDialogs] = useState<Dialog[]>([])
  const [value, setValue] = useState('')
  const [notice, setNotice] = useState<string>()
  const setDraft = useWorkspaceStore((state) => state.setDraft)
  const setExtensionStatus = useWorkspaceStore((state) => state.setExtensionStatus)
  const setExtensionWidget = useWorkspaceStore((state) => state.setExtensionWidget)
  useEffect(() => {
    const unsubscribe = runtime.onPiEvent((event) => {
    const dialog = dialogFrom(event)
    if (dialog) { setDialogs((current) => current.some((item) => item.id === dialog.id) ? current : [...current, dialog]); setValue(dialog.prefill ?? ''); return }
    const raw = event.event
    if (raw.type === 'extension_ui_request' && raw.method === 'set_editor_text' && typeof raw.text === 'string') setDraft(event.sessionId, stripAnsiText(raw.text))
    if (raw.type === 'extension_ui_request' && raw.method === 'setStatus') setExtensionStatus(event.sessionId, typeof raw.statusText === 'string' ? stripAnsiLine(raw.statusText) : undefined)
    if (raw.type === 'extension_ui_request' && raw.method === 'setWidget') setExtensionWidget(event.sessionId, Array.isArray(raw.widgetLines) ? raw.widgetLines.filter((line): line is string => typeof line === 'string').map(stripAnsiLine) : [])
    if (raw.type === 'extension_ui_request' && raw.method === 'setTitle' && typeof raw.title === 'string') document.title = stripAnsiLine(raw.title)
    if (raw.type === 'extension_ui_request' && raw.method === 'notify' && typeof raw.message === 'string') setNotice(stripAnsiLine(raw.message))
    })
    return unsubscribe
  }, [runtime, setDraft, setExtensionStatus, setExtensionWidget])
  const dialog = dialogs[0]
  async function reply(response: { cancelled?: boolean; confirmed?: boolean; value?: unknown }) {
    if (!dialog) return
    await runtime.extensionUiResponse(dialog.sessionId, dialog.id, response).catch(() => undefined)
    setDialogs((current) => current.filter((item) => item.id !== dialog.id))
  }
  return <>{notice && <div aria-live="polite" className="fixed bottom-4 right-4 z-50 rounded bg-card p-3 shadow">{notice}</div>}{dialog && <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4" role="presentation"><section aria-modal="true" className="w-full max-w-lg space-y-4 rounded-lg bg-background p-5 shadow-xl" role="dialog"><h2 className="font-semibold">{dialog.title}</h2>{dialog.message && <p className="text-sm text-muted-foreground">{dialog.message}</p>}{dialog.method === 'confirm' ? null : dialog.method === 'select' ? <select className="w-full rounded border p-2" onChange={(event) => setValue(event.target.value)} value={value}>{dialog.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <textarea className="min-h-32 w-full rounded border p-2" onChange={(event) => setValue(event.target.value)} value={value} />}<div className="flex justify-end gap-2"><Button onClick={() => void reply({ cancelled: true })} variant="ghost">取消</Button><Button onClick={() => void reply(dialog.method === 'confirm' ? { confirmed: true } : { value })}>{dialog.method === 'confirm' ? '确认' : '提交'}</Button></div></section></div>}</>
}
