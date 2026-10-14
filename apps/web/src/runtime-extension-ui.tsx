// oxlint-disable react/only-export-components -- protocol mapping helpers are tested with the inline bridge.
import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

import { stripAnsiLine, stripAnsiText } from './ansi-text.js'
import { RuntimeWebSocketClient, type PiRuntimeEvent } from './runtime-websocket-client.js'
import { useWorkspaceStore } from './workspace-store.js'

type ExtensionOption = { displayLabel: string; rawValue: string }
type DialogMethod = 'confirm' | 'editor' | 'input' | 'select'
type Dialog = {
  error?: string
  editorId?: string
  id: string
  message?: string
  method: DialogMethod
  options?: ExtensionOption[]
  placeholder?: string
  prefill?: string
  selectedValue?: string
  runId?: string
  sessionId: string
  submitting?: boolean
  title: string
  value?: string
}
type ExtensionUi = { dialogs: Dialog[]; reply: (dialog: Dialog, response: { cancelled?: boolean; confirmed?: boolean; value?: string }) => Promise<void>; setValue: (dialog: Dialog, value: string, customText?: boolean) => void }

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
    runId: event.runId,
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

export function selectResponse(dialog: Pick<Dialog, 'selectedValue'> & Partial<Pick<Dialog, 'options' | 'value'>>) {
  if (isCustomAnswerSelection(dialog) && !dialog.value?.trim()) return undefined
  return dialog.selectedValue === undefined ? undefined : { value: dialog.selectedValue }
}

export function isCustomAnswerEditor(question: Pick<Dialog, 'sessionId' | 'runId' | 'title'>, editor: Pick<Dialog, 'sessionId' | 'runId' | 'title' | 'method'>) {
  return editor.method === 'editor' && question.sessionId === editor.sessionId && question.runId === editor.runId && question.title.endsWith(`: ${editor.title}`)
}

// shortcut: RPC has no custom-answer flag; match pi-tui-kit's label until it exposes one.
export function isCustomAnswerSelection(dialog: Pick<Dialog, 'options' | 'selectedValue'>) {
  const selected = dialog.options?.find((option) => option.rawValue === dialog.selectedValue)
  return selected !== undefined && /^\d+\. Other \(free-form\)$/.test(selected.displayLabel)
}

// ponytail: Pi's plan extension has no semantic action field; use one when Pi RPC exposes it.
export function planImplementationPrompt(dialog: Pick<Dialog, 'method' | 'options' | 'title'>, response: { cancelled?: boolean; value?: string }) {
  if (response.cancelled || dialog.method !== 'select' || response.value !== 'Implement here' || !dialog.title.startsWith('Proposed plan ready.')) return undefined
  return dialog.options?.some((option) => option.rawValue === 'Start fresh and implement') ? 'Implement the plan.' : undefined
}

export function isQuestionnaireFailure(message: string) {
  return /^Questionnaire failed:/i.test(message)
}

// pi-plan-mode mirrors this lifecycle state through setStatus beside the composer.
export function isPlanModeLifecycleNotice(message: string) {
  return message === 'Plan mode enabled. I will explore and plan, but not modify files.'
}

/** Native Pi RPC Extension UI bridge. It keeps protocol values untouched and lets workspace render dialogs inline. */
export function RuntimeExtensionUi({ children, runtime }: { children: React.ReactNode; runtime: RuntimeWebSocketClient }) {
  const [dialogs, setDialogs] = useState<Dialog[]>([])
  const [notice, setNotice] = useState<{ message: string; type: 'error' | 'info' | 'warning' }>()
  const customAnswers = useRef(new Map<string, Dialog>())
  const submissions = useRef(new Set<string>())

  const reply = useCallback(async (dialog: Dialog, response: { cancelled?: boolean; confirmed?: boolean; value?: string }) => {
    const targetId = dialog.editorId ?? dialog.id
    const submissionKey = `${dialog.sessionId}:${targetId}`
    if (dialog.submitting || submissions.current.has(submissionKey)) return
    const custom = dialog.method === 'select' && isCustomAnswerSelection(dialog) && !response.cancelled
    if (custom && !dialog.value?.trim()) return
    submissions.current.add(submissionKey)
    if (custom) customAnswers.current.set(dialog.sessionId, { ...dialog, submitting: true })
    const prompt = planImplementationPrompt(dialog, response)
    const input = prompt ? { id: `plan-implementation:${dialog.id}`, message: prompt, mode: 'plan_implementation' as const, submittedAt: new Date().toISOString() } : undefined
    if (input) useWorkspaceStore.getState().appendPendingInput(dialog.sessionId, input)
    setDialogs((current) => current.map((item) => item.id === dialog.id && item.sessionId === dialog.sessionId ? { ...item, error: undefined, submitting: true } : item))
    try {
      await runtime.extensionUiResponse(dialog.sessionId, targetId, dialog.editorId && !response.cancelled ? { value: dialog.value } : response)
      if (custom && (!dialog.editorId || customAnswers.current.get(dialog.sessionId)?.editorId !== targetId)) return
      customAnswers.current.delete(dialog.sessionId)
      setDialogs((current) => current.filter((item) => item.id !== dialog.id || item.sessionId !== dialog.sessionId))
    } catch (cause) {
      if (input) useWorkspaceStore.getState().removePendingInput(dialog.sessionId, input.id)
      if (cause && typeof cause === 'object' && (cause as { code?: unknown }).code === 'EXTENSION_UI_NOT_PENDING') {
        customAnswers.current.delete(dialog.sessionId)
        setDialogs((current) => current.filter((item) => item.id !== dialog.id || item.sessionId !== dialog.sessionId))
        return
      }
      const error = cause instanceof Error ? cause.message : 'Pi extension response failed'
      if (custom && !dialog.editorId) customAnswers.current.delete(dialog.sessionId)
      else if (custom) customAnswers.current.set(dialog.sessionId, { ...dialog, error, submitting: false })
      setDialogs((current) => current.map((item) => item.id === dialog.id && item.sessionId === dialog.sessionId ? { ...item, error, submitting: false } : item))
    } finally { submissions.current.delete(submissionKey) }
  }, [runtime])

  const acceptCustomEditor = useCallback((editor: Dialog) => {
    const question = customAnswers.current.get(editor.sessionId)
    if (!question || !isCustomAnswerEditor(question, editor)) return false
    if (question.editorId === editor.id) return true
    const firstEditor = question.editorId === undefined
    const updated = { ...question, editorId: editor.id, submitting: false, error: firstEditor ? undefined : '请检查自定义回答后重试。' }
    customAnswers.current.set(editor.sessionId, updated)
    setDialogs((current) => [...current.filter((item) => item.sessionId !== updated.sessionId || item.id !== updated.id), updated])
    if (firstEditor) void reply(updated, { value: updated.value })
    return true
  }, [reply])

  useEffect(() => {
    const customAnswerMap = customAnswers.current
    const submissionSet = submissions.current
    const unsubscribeEvents = runtime.onPiEvent((event) => {
      const dialog = dialogFrom(event)
      if (dialog) {
        if (!runtime.shouldApplyExtensionUi(event)) return
        if (acceptCustomEditor(dialog)) return
        setDialogs((current) => current.some((item) => item.id === dialog.id && item.sessionId === dialog.sessionId) ? current : [...current, dialog])
        return
      }
      const raw = event.event
      if (raw.type === 'extension_ui_resolved' && typeof raw.dialogId === 'string') {
        setDialogs((current) => current.filter((item) => item.id !== raw.dialogId || item.sessionId !== event.sessionId || customAnswers.current.get(item.sessionId)?.id === item.id))
        return
      }
      if (raw.type === 'extension_ui_request' && raw.method === 'setTitle' && typeof raw.title === 'string') document.title = stripAnsiLine(raw.title)
      if (raw.type === 'extension_ui_request' && raw.method === 'notify' && typeof raw.message === 'string') {
        const message = stripAnsiLine(raw.message)
        if (isQuestionnaireFailure(message)) {
          setDialogs((current) => current.map((item) => {
            if (item.sessionId !== event.sessionId) return item
            return { ...item, error: message, submitting: false }
          }))
        } else if (!isPlanModeLifecycleNotice(message)) {
          const type = raw.notifyType === 'error' || raw.notifyType === 'warning' ? raw.notifyType : 'info'
          setNotice({ message, type })
        }
      }
    })
    const unsubscribeSnapshots = runtime.onSessionSnapshot((snapshot) => {
      const dialogs = (snapshot.pendingExtensionDialogs ?? []).flatMap((event) => {
        const dialog = dialogFrom(event)
        return dialog && dialog.sessionId === snapshot.sessionId && !acceptCustomEditor(dialog) ? [dialog] : []
      })
      setDialogs((current) => [
        ...current.filter((item) => item.sessionId !== snapshot.sessionId),
        ...(customAnswers.current.has(snapshot.sessionId) ? [customAnswers.current.get(snapshot.sessionId)!] : []),
        ...dialogs.filter((dialog) => dialog.id !== customAnswers.current.get(snapshot.sessionId)?.id).map((dialog) => {
          const existing = current.find((item) => item.sessionId === dialog.sessionId && item.id === dialog.id)
          return existing ? { ...dialog, selectedValue: existing.selectedValue ?? dialog.selectedValue, value: existing.value ?? dialog.value } : dialog
        }),
      ])
    })
    const unsubscribeStatus = runtime.onRuntimeStatus((status) => {
      if (status.lifecycle === 'failed') {
        customAnswers.current.delete(status.sessionId)
        setDialogs((current) => current.filter((item) => item.sessionId !== status.sessionId))
      }
    })
    const unsubscribeResync = runtime.onResyncRequired((message) => {
      customAnswers.current.delete(message.sessionId)
      setDialogs((current) => current.filter((item) => item.sessionId !== message.sessionId))
    })
    return () => { customAnswerMap.clear(); submissionSet.clear(); unsubscribeEvents(); unsubscribeSnapshots(); unsubscribeStatus(); unsubscribeResync() }
  }, [runtime, acceptCustomEditor])

  useEffect(() => {
    if (!notice || notice.type !== 'info') return
    const timer = window.setTimeout(() => setNotice(undefined), 5_000)
    return () => window.clearTimeout(timer)
  }, [notice])


  function setValue(dialog: Dialog, value: string, customText = false) {
    const pending = customAnswers.current.get(dialog.sessionId)
    if (customText && pending?.id === dialog.id) customAnswers.current.set(dialog.sessionId, { ...pending, value })
    setDialogs((current) => current.map((item) => item.id === dialog.id && item.sessionId === dialog.sessionId
      ? item.method === 'select' && !customText ? { ...item, selectedValue: value } : { ...item, value }
      : item))
  }

  return <ExtensionUiContext.Provider value={{ dialogs, reply, setValue }}>{children}{notice && <div aria-live="polite" className="fixed bottom-4 right-4 z-50 flex max-w-md items-start gap-3 rounded bg-card p-3 shadow"><p className="min-w-0 break-words text-sm">{notice.message}</p><Button aria-label="关闭通知" className="h-auto p-0 text-muted-foreground" onClick={() => setNotice(undefined)} size="sm" type="button" variant="ghost">关闭</Button></div>}</ExtensionUiContext.Provider>
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
    if (dialog.submitting) return
    if (event.target !== event.currentTarget && (event.target as HTMLElement).getAttribute('role') !== 'radio') return
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1) }
    else if (event.key === 'Escape') { event.preventDefault(); void reply(dialog, { cancelled: true }) }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); const response = selectResponse(dialog); if (response) void reply(dialog, response) }
  }} tabIndex={0}>
    <div className="space-y-1"><h2 className="font-semibold">{dialog.title}</h2>{dialog.message && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{dialog.message}</p>}</div>
    <div aria-label="选项" className="max-h-[min(50vh,24rem)] space-y-2 overflow-y-auto overscroll-contain" role="radiogroup">
      {options.map((option, index) => {
        const { description, title } = optionParts(option.displayLabel)
        const selected = option.rawValue === dialog.selectedValue
        const customOption = isCustomAnswerSelection({ options: [option], selectedValue: option.rawValue })
        return <div className={`rounded-lg border ${customOption ? 'flex items-center gap-2 pr-3' : ''} ${selected ? 'border-primary bg-primary/8' : 'border-transparent'}`} key={`${index}:${option.rawValue}`}>
          <button disabled={dialog.submitting || dialog.editorId !== undefined} aria-checked={selected} className={`block rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${customOption ? 'shrink-0' : 'w-full'}`} onClick={() => setValue(dialog, option.rawValue)} role="radio" type="button">
            <span className="flex items-start gap-3"><span aria-hidden="true" className="mt-0.5 text-primary">{selected ? '●' : '○'}</span><span className="min-w-0 whitespace-pre-wrap break-words"><span className="block font-medium">{customOption ? `${index + 1}.` : title}</span>{description && <span className="mt-1 block text-sm text-muted-foreground">{description}</span>}</span></span>
          </button>
          {customOption && <input aria-label="自定义回答" className="my-2 min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={dialog.submitting} placeholder="other" value={dialog.value ?? ''} onFocus={() => setValue(dialog, option.rawValue)} onChange={(event) => { setValue(dialog, option.rawValue); setValue(dialog, event.target.value, true) }} onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            const response = selectResponse(dialog)
            if (response) void reply(dialog, response)
          }} />}
        </div>
      })}
    </div>
    {dialog.error && <p className="text-sm text-destructive" role="alert">{dialog.error}</p>}
    <div className="flex justify-end gap-2"><Button disabled={dialog.submitting} onClick={() => void reply(dialog, { cancelled: true })} type="button" variant="ghost">取消</Button><Button disabled={dialog.submitting || selectResponse(dialog) === undefined} onClick={() => { const response = selectResponse(dialog); if (response) void reply(dialog, response) }} type="button">{dialog.submitting ? '提交中…' : '继续'}</Button></div>
  </section>
}

function ExtensionTextCard({ dialog, reply, setValue }: { dialog: Dialog; reply: ExtensionUi['reply']; setValue: ExtensionUi['setValue'] }) {
  const confirm = dialog.method === 'confirm'
  return <section aria-label={dialog.title} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm"><div className="space-y-1"><h2 className="font-semibold">{dialog.title}</h2>{dialog.message && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{dialog.message}</p>}</div>{!confirm && (dialog.method === 'input' ? <input autoFocus aria-label={dialog.title} disabled={dialog.submitting} className="w-full rounded-md border bg-background px-3 py-2" onChange={(event) => setValue(dialog, event.target.value)} placeholder={dialog.placeholder} value={dialog.value ?? ''} /> : <Textarea autoFocus aria-label={dialog.title} disabled={dialog.submitting} className="min-h-40 w-full rounded-md border bg-background p-3" onChange={(event) => setValue(dialog, event.target.value)} value={dialog.value ?? ''} />)}{dialog.error && <p className="text-sm text-destructive" role="alert">{dialog.error}</p>}<div className="flex justify-end gap-2"><Button disabled={dialog.submitting} onClick={() => void reply(dialog, { cancelled: true })} type="button" variant="ghost">取消</Button><Button disabled={dialog.submitting} onClick={() => void reply(dialog, confirm ? { confirmed: true } : { value: dialog.value ?? '' })} type="button">{dialog.submitting ? '提交中…' : confirm ? '确认' : '继续'}</Button></div></section>
}

/** Renders only the first pending request for the visible Pi session; other requests stay queued. */
export function ExtensionUiInline({ sessionId }: { sessionId: string }) {
  const extensionUi = useContext(ExtensionUiContext)
  if (!extensionUi || !sessionId) return null
  const dialog = extensionUi.dialogs.find((item) => item.sessionId === sessionId)
  if (!dialog) return null
  return dialog.method === 'select'
    ? <ExtensionSelectCard dialog={dialog} reply={extensionUi.reply} setValue={extensionUi.setValue} key={dialog.id} />
    : <ExtensionTextCard dialog={dialog} reply={extensionUi.reply} setValue={extensionUi.setValue} key={dialog.id} />
}
