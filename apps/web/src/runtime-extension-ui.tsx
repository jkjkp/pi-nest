import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

import { dialogFrom, isCustomAnswerEditor, isCustomAnswerSelection, isPlanImplementationOption, planActionOptions, planImplementationPrompt, readExtensionPresentation, selectResponse, type ExtensionDialog } from './runtime-extension-event.js'
import type { RuntimeWebSocketClient } from './runtime-websocket-client.js'
import type { SessionRunController } from './session-run-controller.js'

type Dialog = ExtensionDialog & { error?: string; editorId?: string; submitting?: boolean }
type ExtensionUi = { statusNotice?: { sessionId: string; message: string }; dialogs: Dialog[]; reply: (dialog: Dialog, response: { cancelled?: boolean; confirmed?: boolean; value?: string }) => Promise<void>; setValue: (dialog: Dialog, value: string, customText?: boolean) => void }

const ExtensionUiContext = createContext<ExtensionUi | undefined>(undefined)

/** Native Pi RPC Extension UI bridge. It keeps protocol values untouched and lets workspace render dialogs inline. */
export function RuntimeExtensionUi({ children, runtime, sessionRuns, activeSessionId }: { children: React.ReactNode; runtime: RuntimeWebSocketClient; sessionRuns: SessionRunController; activeSessionId?: string }) {
  const [dialogs, setDialogs] = useState<Dialog[]>([])
  const [notice, setNotice] = useState<{ sessionId: string; message: string; type: 'error' | 'info' | 'warning' }>()
  const [noticeSessionId, setNoticeSessionId] = useState(activeSessionId)
  if (noticeSessionId !== activeSessionId) { setNoticeSessionId(activeSessionId); setNotice(undefined) }
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
    const pendingInputId = prompt ? sessionRuns.queuePlanImplementation(dialog.sessionId, dialog.id, prompt) : undefined
    setDialogs((current) => current.map((item) => item.id === dialog.id && item.sessionId === dialog.sessionId ? { ...item, error: undefined, submitting: true } : item))
    try {
      await sessionRuns.respondToExtension(dialog.sessionId, targetId, dialog.editorId && !response.cancelled ? { value: dialog.value } : response, pendingInputId)
      if (custom && (!dialog.editorId || customAnswers.current.get(dialog.sessionId)?.editorId !== targetId)) return
      customAnswers.current.delete(dialog.sessionId)
      setDialogs((current) => current.filter((item) => item.id !== dialog.id || item.sessionId !== dialog.sessionId))
    } catch (cause) {
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
  }, [sessionRuns])

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
      const presentation = readExtensionPresentation(event)
      if (!presentation) return
      if (presentation.kind === 'dialog_closed') {
        const { dialogId } = presentation
        setDialogs((current) => current.filter((item) => item.id !== dialogId || item.sessionId !== event.sessionId || customAnswers.current.get(item.sessionId)?.id === item.id))
        return
      }
      if (!runtime.shouldApplyExtensionUi(event)) return
      if (presentation.kind === 'dialog') {
        const { dialog } = presentation
        if (acceptCustomEditor(dialog)) return
        setDialogs((current) => current.some((item) => item.id === dialog.id && item.sessionId === dialog.sessionId) ? current : [...current, dialog])
      } else if (presentation.kind === 'title') {
        document.title = presentation.title
      } else if (presentation.kind === 'questionnaire_error') {
        setDialogs((current) => current.map((item) => item.sessionId === event.sessionId ? { ...item, error: presentation.text, submitting: false } : item))
      } else {
        setNotice({ sessionId: event.sessionId, message: presentation.text, type: presentation.level })
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
    if (!notice || notice.type === 'error') return
    const timer = window.setTimeout(() => setNotice(undefined), notice.type === 'info' ? 500 : 5_000)
    return () => window.clearTimeout(timer)
  }, [notice])


  function setValue(dialog: Dialog, value: string, customText = false) {
    const pending = customAnswers.current.get(dialog.sessionId)
    if (customText && pending?.id === dialog.id) customAnswers.current.set(dialog.sessionId, { ...pending, value })
    setDialogs((current) => current.map((item) => item.id === dialog.id && item.sessionId === dialog.sessionId
      ? item.method === 'select' && !customText ? { ...item, selectedValue: value } : { ...item, value }
      : item))
  }

  return <ExtensionUiContext.Provider value={{ dialogs, reply, setValue, statusNotice: notice?.type === 'info' && (activeSessionId === undefined || notice.sessionId === activeSessionId) ? notice : undefined }}>{children}{notice && notice.type !== 'info' && (activeSessionId === undefined || notice.sessionId === activeSessionId) && <div aria-live="polite" className="fixed bottom-4 right-4 z-50 flex max-w-md items-start gap-3 rounded bg-card p-3 shadow"><p className="min-w-0 break-words text-sm">{notice.message}</p><Button aria-label="关闭通知" className="h-auto p-0 text-muted-foreground" onClick={() => setNotice(undefined)} size="sm" type="button" variant="ghost">关闭</Button></div>}</ExtensionUiContext.Provider>
}

/** Brief status feedback stays next to its composer without taking layout space. */
export function ExtensionStatusNotice({ sessionId }: { sessionId: string }) {
  const notice = useContext(ExtensionUiContext)?.statusNotice
  if (!notice || notice.sessionId !== sessionId) return null
  return <div data-slot="extension-status-notice" role="status" aria-atomic="true" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-md bg-gray-600 px-3 py-2 text-center text-xs break-words text-white shadow-sm">{notice.message}</div>
}

function optionParts(label: string) {
  const [title, ...description] = label.split('\n')
  return { description: description.join('\n'), title }
}

type PlanPreview = { planTurnId?: string; onViewPlan?: () => void; onRetryPlan?: () => void }

function PlanActions({ actions, dialog, reply, planTurnId, onViewPlan, onRetryPlan }: { actions: NonNullable<ReturnType<typeof planActionOptions>>; dialog: Dialog; reply: ExtensionUi['reply'] } & PlanPreview) {
  const [reading, setReading] = useState(false)
  return <section aria-label="计划操作" className="mx-auto w-full max-w-[640px] space-y-2 rounded-lg border bg-card p-2 text-sm shadow-sm">
    <div className="flex items-center justify-between gap-2"><span className="font-normal">{planTurnId ? '计划已就绪' : '计划内容待加载'}</span>{reading
      ? <Button size="sm" variant="ghost" type="button" onClick={() => setReading(false)}>返回操作</Button>
      : <Button size="sm" variant="ghost" type="button" onClick={() => { if (planTurnId) { setReading(true); onViewPlan?.() } else onRetryPlan?.() }}>{planTurnId ? '查看计划' : '加载计划'}</Button>}</div>
    {!reading && <div className="flex flex-wrap items-center gap-2">{actions.primary.map((option) => <Button key={option.rawValue} disabled={dialog.submitting || !planTurnId} size="sm" type="button" variant={option.kind === 'implement_here' ? 'default' : 'outline'} onClick={() => void reply(dialog, { value: option.rawValue })}>{option.displayLabel}</Button>)}
      <DropdownMenu><DropdownMenuTrigger asChild><Button disabled={dialog.submitting} size="sm" type="button" variant="ghost">更多</Button></DropdownMenuTrigger><DropdownMenuContent side="top" align="end" className="max-h-[40dvh] max-w-xs overflow-y-auto">{actions.more.map((option) => <DropdownMenuItem key={option.rawValue} onSelect={() => void reply(dialog, { value: option.rawValue })}>{option.menuLabel ?? option.displayLabel}</DropdownMenuItem>)}<DropdownMenuItem onSelect={() => void reply(dialog, { cancelled: true })}>取消</DropdownMenuItem><div className="mt-1 border-t px-2 py-2 text-xs text-muted-foreground"><p className="mb-1 font-normal">操作说明</p><p className="whitespace-pre-wrap">{dialog.title}{dialog.message ? `\n${dialog.message}` : ''}</p></div></DropdownMenuContent></DropdownMenu>
      {dialog.submitting && <span className="text-xs text-muted-foreground" role="status">提交中…</span>}
    </div>}
    {dialog.error && <p className="max-h-12 overflow-auto text-xs text-destructive" role="alert">{dialog.error}</p>}
  </section>
}

function ExtensionSelectCard({ dialog, reply, setValue, planTurnId }: { dialog: Dialog; reply: ExtensionUi['reply']; setValue: ExtensionUi['setValue'] } & PlanPreview) {
  const [collapsed, setCollapsed] = useState(false)
  const options = dialog.options ?? []
  const selectedIndex = options.findIndex((option) => option.rawValue === dialog.selectedValue)
  const canSubmit = selectResponse(dialog) !== undefined && (!options[selectedIndex] || !isPlanImplementationOption(options[selectedIndex]) || !!planTurnId)
  function moveSelection(delta: number) {
    if (options.length === 0) return
    const next = (Math.max(selectedIndex, 0) + delta + options.length) % options.length
    setValue(dialog, options[next]!.rawValue)
  }
  return <section aria-label={dialog.title} data-extension-question-expanded={!collapsed} className={`mx-auto flex w-full max-w-[640px] flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-sm ${collapsed ? '' : 'max-h-[min(35dvh,22rem)]'}`} onKeyDown={(event) => {
    if (dialog.submitting || collapsed) return
    if (event.target !== event.currentTarget && (event.target as HTMLElement).getAttribute('role') !== 'radio') return
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1) }
    else if (event.key === 'Escape') { event.preventDefault(); void reply(dialog, { cancelled: true }) }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing && canSubmit) { event.preventDefault(); const response = selectResponse(dialog); if (response) void reply(dialog, response) }
  }} tabIndex={0}>
    <div className="flex shrink-0 items-start justify-between gap-2"><h2 className="max-h-16 min-w-0 overflow-auto font-normal">{collapsed ? dialog.error ? '回答提交失败' : '等待你的回答' : dialog.title}</h2><Button className="shrink-0" aria-expanded={!collapsed} size="sm" type="button" variant="ghost" onClick={() => setCollapsed(!collapsed)}>{collapsed ? '展开问题' : '收起问题'}</Button></div>
    {!collapsed && <>
    <div aria-label="选项" className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain" role="radiogroup">
      {dialog.message && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{dialog.message}</p>}
      {options.map((option, index) => {
        const { description, title } = optionParts(option.displayLabel)
        const selected = option.rawValue === dialog.selectedValue
        const customOption = option.kind === 'custom_answer'
        return <div className={`rounded-lg border ${customOption ? 'flex items-center gap-2 pr-3' : ''} ${selected ? 'border-primary bg-primary/8' : 'border-transparent'}`} key={`${index}:${option.rawValue}`}>
          <button disabled={dialog.submitting || dialog.editorId !== undefined} aria-checked={selected} className={`block rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${customOption ? 'shrink-0' : 'w-full'}`} onClick={() => setValue(dialog, option.rawValue)} role="radio" type="button">
            <span className="flex items-start gap-2"><span aria-hidden="true" className="mt-0.5 text-link">{selected ? '●' : '○'}</span><span className="min-w-0 whitespace-pre-wrap break-words"><span className="block font-normal">{customOption ? `${index + 1}.` : title}</span>{description && <span className="mt-0.5 block text-xs leading-[calc(20px*var(--font-scale))] text-muted-foreground">{description}</span>}</span></span>
          </button>
          {customOption && <input aria-label="自定义回答" className="my-1 h-8 min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={dialog.submitting} placeholder="other" value={dialog.value ?? ''} onFocus={() => setValue(dialog, option.rawValue)} onChange={(event) => { setValue(dialog, option.rawValue); setValue(dialog, event.target.value, true) }} onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            const response = selectResponse(dialog)
            if (response) void reply(dialog, response)
          }} />}
        </div>
      })}
    </div>
    {dialog.error && <p className="max-h-12 shrink-0 overflow-auto text-xs text-destructive" role="alert">{dialog.error}</p>}
    <div className="flex shrink-0 justify-end gap-2"><Button size="sm" disabled={dialog.submitting} onClick={() => void reply(dialog, { cancelled: true })} type="button" variant="ghost">取消</Button><Button size="sm" disabled={dialog.submitting || !canSubmit} onClick={() => { const response = selectResponse(dialog); if (response) void reply(dialog, response) }} type="button">{dialog.submitting ? '提交中…' : '继续'}</Button></div>
    </>}
  </section>
}

function ExtensionTextCard({ dialog, reply, setValue }: { dialog: Dialog; reply: ExtensionUi['reply']; setValue: ExtensionUi['setValue'] }) {
  const confirm = dialog.method === 'confirm'
  return <section aria-label={dialog.title} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm"><div className="space-y-1"><h2 className="font-normal">{dialog.title}</h2>{dialog.message && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{dialog.message}</p>}</div>{!confirm && (dialog.method === 'input' ? <input autoFocus aria-label={dialog.title} disabled={dialog.submitting} className="w-full rounded-md border bg-background px-3 py-2" onChange={(event) => setValue(dialog, event.target.value)} placeholder={dialog.placeholder} value={dialog.value ?? ''} /> : <Textarea autoFocus aria-label={dialog.title} disabled={dialog.submitting} className="min-h-40 w-full rounded-md border bg-background p-3" onChange={(event) => setValue(dialog, event.target.value)} value={dialog.value ?? ''} />)}{dialog.error && <p className="text-sm text-destructive" role="alert">{dialog.error}</p>}<div className="flex justify-end gap-2"><Button disabled={dialog.submitting} onClick={() => void reply(dialog, { cancelled: true })} type="button" variant="ghost">取消</Button><Button disabled={dialog.submitting} onClick={() => void reply(dialog, confirm ? { confirmed: true } : { value: dialog.value ?? '' })} type="button">{dialog.submitting ? '提交中…' : confirm ? '确认' : '继续'}</Button></div></section>
}

/** Renders only the first pending request for the visible Pi session; other requests stay queued. */
export function ExtensionUiInline({ sessionId, ...planPreview }: { sessionId: string } & PlanPreview) {
  const extensionUi = useContext(ExtensionUiContext)
  if (!extensionUi || !sessionId) return null
  const dialog = extensionUi.dialogs.find((item) => item.sessionId === sessionId)
  if (!dialog) return null
  const actions = planActionOptions(dialog)
  if (actions) return <PlanActions actions={actions} dialog={dialog} reply={extensionUi.reply} key={dialog.id} {...planPreview} />
  return dialog.method === 'select'
    ? <ExtensionSelectCard dialog={dialog} reply={extensionUi.reply} setValue={extensionUi.setValue} key={dialog.id} {...planPreview} />
    : <ExtensionTextCard dialog={dialog} reply={extensionUi.reply} setValue={extensionUi.setValue} key={dialog.id} />
}
