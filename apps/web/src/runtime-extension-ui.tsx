// oxlint-disable react/only-export-components -- protocol mapping helpers are tested with the inline bridge.
import { createContext, useContext, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'

import { stripAnsiLine, stripAnsiText } from './ansi-text.js'
import { RuntimeWebSocketClient, type PiRuntimeEvent } from './runtime-websocket-client.js'
import { useWorkspaceStore } from './workspace-store.js'

type ExtensionOption = { displayLabel: string; rawValue: string }
type DialogMethod = 'confirm' | 'editor' | 'input' | 'select'
type Dialog = {
  error?: string
  id: string
  message?: string
  method: DialogMethod
  options?: ExtensionOption[]
  placeholder?: string
  prefill?: string
  selectedValue?: string
  sessionId: string
  submitting?: boolean
  title: string
  value?: string
}
type ExtensionUi = { dialogs: Dialog[]; reply: (dialog: Dialog, response: { cancelled?: boolean; confirmed?: boolean; value?: string }) => Promise<void>; setValue: (dialog: Dialog, value: string) => void }

const ExtensionUiContext = createContext<ExtensionUi | undefined>(undefined)

export function dialogFrom(event: PiRuntimeEvent): Dialog | undefined {
  const value = event.event
  if (value.type !== 'extension_ui_request' || typeof value.id !== 'string' || typeof value.method !== 'string') return undefined
  if (value.method !== 'select' && value.method !== 'confirm' && value.method !== 'input' && value.method !== 'editor') return undefined
  const options = value.method === 'select' && Array.isArray(value.options)
    ? value.options.filter((item): item is string => typeof item === 'string').map((rawValue) => ({ displayLabel: stripAnsiText(rawValue), rawValue }))
    : undefined
  return {
    id: value.id,
    message: typeof value.message === 'string' ? stripAnsiLine(value.message) : undefined,
    method: value.method,
    options,
    placeholder: typeof value.placeholder === 'string' ? stripAnsiLine(value.placeholder) : undefined,
    prefill: typeof value.prefill === 'string' ? stripAnsiText(value.prefill) : undefined,
    selectedValue: options?.[0]?.rawValue,
    sessionId: event.sessionId,
    title: typeof value.title === 'string' ? stripAnsiLine(value.title) : 'Pi extension request',
    value: typeof value.prefill === 'string' ? stripAnsiText(value.prefill) : '',
  }
}

export function selectResponse(dialog: Pick<Dialog, 'selectedValue'>) {
  return dialog.selectedValue === undefined ? undefined : { value: dialog.selectedValue }
}

export function isQuestionnaireFailure(message: string) {
  return /^Questionnaire failed:/i.test(message)
}

/** Native Pi RPC Extension UI bridge. It keeps protocol values untouched and lets workspace render dialogs inline. */
export function RuntimeExtensionUi({ children, runtime }: { children: React.ReactNode; runtime: RuntimeWebSocketClient }) {
  const [dialogs, setDialogs] = useState<Dialog[]>([])
  const [notice, setNotice] = useState<string>()
  const setDraft = useWorkspaceStore((state) => state.setDraft)
  const clearExtensionUi = useWorkspaceStore((state) => state.clearExtensionUi)
  const replaceExtensionUi = useWorkspaceStore((state) => state.replaceExtensionUi)
  const setExtensionStatus = useWorkspaceStore((state) => state.setExtensionStatus)
  const setExtensionWidget = useWorkspaceStore((state) => state.setExtensionWidget)
  const setRuntimeState = useWorkspaceStore((state) => state.setRuntimeState)

  useEffect(() => {
    const unsubscribeEvents = runtime.onPiEvent((event) => {
      const dialog = dialogFrom(event)
      if (dialog) {
        setDialogs((current) => current.some((item) => item.id === dialog.id && item.sessionId === dialog.sessionId) ? current : [...current, dialog])
        return
      }
      const raw = event.event
      if (raw.type === 'extension_ui_request' && raw.method === 'set_editor_text' && typeof raw.text === 'string') setDraft(event.sessionId, stripAnsiText(raw.text))
      if (raw.type === 'extension_ui_request' && raw.method === 'setStatus' && runtime.shouldApplyExtensionUi(event) && typeof raw.statusKey === 'string' && raw.statusKey) setExtensionStatus(event.sessionId, raw.statusKey, typeof raw.statusText === 'string' ? raw.statusText : undefined)
      if (raw.type === 'extension_ui_request' && raw.method === 'setWidget' && runtime.shouldApplyExtensionUi(event) && typeof raw.widgetKey === 'string' && raw.widgetKey) setExtensionWidget(event.sessionId, raw.widgetKey, Array.isArray(raw.widgetLines) && raw.widgetLines.every((line) => typeof line === 'string') ? raw.widgetLines : undefined)
      if (raw.type === 'extension_ui_request' && raw.method === 'setTitle' && typeof raw.title === 'string') document.title = stripAnsiLine(raw.title)
      if (raw.type === 'extension_ui_request' && raw.method === 'notify' && typeof raw.message === 'string') {
        const message = stripAnsiLine(raw.message)
        if (isQuestionnaireFailure(message)) {
          setDialogs((current) => current.map((item) => {
            if (item.sessionId !== event.sessionId) return item
            return { ...item, error: message, submitting: false }
          }))
        } else setNotice(message)
      }
    })
    const unsubscribeSnapshots = runtime.onSessionSnapshot((snapshot) => {
      replaceExtensionUi(snapshot.sessionId, snapshot.extensionUi)
      setRuntimeState(snapshot.sessionId, snapshot.runtime)
    })
    const unsubscribeStatus = runtime.onRuntimeStatus((status) => {
      setRuntimeState(status.sessionId, status)
      if (status.lifecycle === 'failed') clearExtensionUi(status.sessionId)
    })
    const unsubscribeResync = runtime.onResyncRequired((message) => clearExtensionUi(message.sessionId))
    return () => { unsubscribeEvents(); unsubscribeSnapshots(); unsubscribeStatus(); unsubscribeResync() }
  }, [runtime, clearExtensionUi, replaceExtensionUi, setDraft, setExtensionStatus, setExtensionWidget, setRuntimeState])

  async function reply(dialog: Dialog, response: { cancelled?: boolean; confirmed?: boolean; value?: string }) {
    if (dialog.submitting) return
    setDialogs((current) => current.map((item) => item.id === dialog.id && item.sessionId === dialog.sessionId ? { ...item, error: undefined, submitting: true } : item))
    try {
      await runtime.extensionUiResponse(dialog.sessionId, dialog.id, response)
      setDialogs((current) => current.filter((item) => item.id !== dialog.id || item.sessionId !== dialog.sessionId))
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'Pi extension response failed'
      setDialogs((current) => current.map((item) => item.id === dialog.id && item.sessionId === dialog.sessionId ? { ...item, error, submitting: false } : item))
    }
  }

  function setValue(dialog: Dialog, value: string) {
    setDialogs((current) => current.map((item) => item.id === dialog.id && item.sessionId === dialog.sessionId
      ? item.method === 'select' ? { ...item, selectedValue: value } : { ...item, value }
      : item))
  }

  return <ExtensionUiContext.Provider value={{ dialogs, reply, setValue }}>{children}{notice && <div aria-live="polite" className="fixed bottom-4 right-4 z-50 rounded bg-card p-3 shadow">{notice}</div>}</ExtensionUiContext.Provider>
}

function optionParts(label: string) {
  const [title, ...description] = label.split('\n')
  return { description: description.join('\n'), title }
}

function ExtensionSelectCard({ dialog, reply, setValue }: { dialog: Dialog; reply: ExtensionUi['reply']; setValue: ExtensionUi['setValue'] }) {
  const options = dialog.options ?? []
  const selectedIndex = options.findIndex((option) => option.rawValue === dialog.selectedValue)
  function moveSelection(delta: number) {
    if (options.length === 0) return
    const next = (Math.max(selectedIndex, 0) + delta + options.length) % options.length
    setValue(dialog, options[next]!.rawValue)
  }
  return <section aria-label={dialog.title} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm" onKeyDown={(event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1) }
    else if (event.key === 'Escape') { event.preventDefault(); void reply(dialog, { cancelled: true }) }
    else if (event.key === 'Enter' && dialog.selectedValue !== undefined) { event.preventDefault(); void reply(dialog, { value: dialog.selectedValue }) }
  }} tabIndex={0}>
    <div className="space-y-1"><h2 className="font-semibold">{dialog.title}</h2>{dialog.message && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{dialog.message}</p>}</div>
    <div aria-label="选项" className="max-h-[min(50vh,24rem)] space-y-2 overflow-y-auto overscroll-contain" role="radiogroup">
      {options.map((option, index) => {
        const { description, title } = optionParts(option.displayLabel)
        const selected = option.rawValue === dialog.selectedValue
        return <button aria-checked={selected} className={`block w-full rounded-lg border px-3 py-2 text-left transition-colors ${selected ? 'border-primary bg-primary/8' : 'border-transparent hover:bg-muted focus-visible:border-primary focus-visible:outline-none'}`} key={`${index}:${option.rawValue}`} onClick={() => setValue(dialog, option.rawValue)} role="radio" type="button">
          <span className="flex items-start gap-3"><span aria-hidden="true" className="mt-0.5 text-primary">{selected ? '●' : '○'}</span><span className="min-w-0 whitespace-pre-wrap break-words"><span className="block font-medium">{title}</span>{description && <span className="mt-1 block text-sm text-muted-foreground">{description}</span>}</span></span>
        </button>
      })}
    </div>
    {dialog.error && <p className="text-sm text-destructive" role="alert">{dialog.error}</p>}
    <div className="flex justify-end gap-2"><Button disabled={dialog.submitting} onClick={() => void reply(dialog, { cancelled: true })} type="button" variant="ghost">取消</Button><Button disabled={dialog.submitting || dialog.selectedValue === undefined} onClick={() => { const response = selectResponse(dialog); if (response) void reply(dialog, response) }} type="button">{dialog.submitting ? '提交中…' : '继续'}</Button></div>
  </section>
}

function ExtensionTextCard({ dialog, reply, setValue }: { dialog: Dialog; reply: ExtensionUi['reply']; setValue: ExtensionUi['setValue'] }) {
  const confirm = dialog.method === 'confirm'
  return <section aria-label={dialog.title} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm"><div className="space-y-1"><h2 className="font-semibold">{dialog.title}</h2>{dialog.message && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{dialog.message}</p>}</div>{!confirm && (dialog.method === 'input' ? <input className="w-full rounded-md border bg-background px-3 py-2" onChange={(event) => setValue(dialog, event.target.value)} placeholder={dialog.placeholder} value={dialog.value ?? ''} /> : <textarea className="min-h-40 w-full rounded-md border bg-background p-3" onChange={(event) => setValue(dialog, event.target.value)} value={dialog.value ?? ''} />)}{dialog.error && <p className="text-sm text-destructive" role="alert">{dialog.error}</p>}<div className="flex justify-end gap-2"><Button disabled={dialog.submitting} onClick={() => void reply(dialog, { cancelled: true })} type="button" variant="ghost">取消</Button><Button disabled={dialog.submitting} onClick={() => void reply(dialog, confirm ? { confirmed: true } : { value: dialog.value ?? '' })} type="button">{dialog.submitting ? '提交中…' : confirm ? '确认' : '继续'}</Button></div></section>
}

/** Renders only the first pending request for the visible Pi session; other requests stay queued. */
export function ExtensionUiInline({ sessionId }: { sessionId: string }) {
  const extensionUi = useContext(ExtensionUiContext)
  if (!extensionUi || !sessionId) return null
  const dialog = extensionUi.dialogs.find((item) => item.sessionId === sessionId)
  if (!dialog) return null
  return dialog.method === 'select'
    ? <ExtensionSelectCard dialog={dialog} reply={extensionUi.reply} setValue={extensionUi.setValue} />
    : <ExtensionTextCard dialog={dialog} reply={extensionUi.reply} setValue={extensionUi.setValue} />
}
