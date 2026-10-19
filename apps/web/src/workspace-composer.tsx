import { useEffect, useImperativeHandle, useState, type ReactNode, type RefObject } from 'react'
import { ListChecks, ListPlus, LoaderCircle, Puzzle, Send, Square, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AttachmentPicker, ComposerAttachments } from './attachment-ui.js'
import { CommandComposer } from './command-composer.js'
import { CommandNotice } from './command-notice.js'
import { parseComposerCommand } from './composer-commands.js'
import { resizeComposerTextarea, useComposerTextarea } from './composer-textarea.js'
import { useComposerHistory } from './composer-history.js'
import { timelineItems } from './timeline-model.js'
import { ExtensionUiInline } from './runtime-extension-ui.js'
import type { SessionRunController } from './session-run-controller.js'
import type { PendingInput } from './session-run-model.js'
import type { useWorkspaceSession } from './use-workspace-session.js'
import type { useWorkspaceCommands } from './use-workspace-commands.js'

type ComposerState = Pick<ReturnType<typeof useWorkspaceSession>,
  'creatingDraft' | 'attachmentDraft' | 'selectedSessionId' | 'selectedSession' | 'isDraft' | 'draftProject' | 'prompt' |
  'currentRun' | 'history' | 'setDraft' | 'setDraftPrompt' | 'status' | 'isActive' | 'submittingInput' |
  'steerQueued' | 'planStatus' | 'planPolicy' | 'extensionStatus' | 'planTurnId' | 'retryHistory' | 'setPendingJump'>

export function WorkspaceComposer({ state, commands, sessionRuns, textareaRef, setComposer, onSubmit, onAbort, controls, canQuery, settingsBusy, error, onError }: {
  state: ComposerState
  commands: ReturnType<typeof useWorkspaceCommands>
  sessionRuns: SessionRunController
  textareaRef: RefObject<HTMLTextAreaElement | null>
  setComposer: (node: HTMLDivElement | null) => void
  onSubmit: (mode?: 'follow_up' | 'steer') => void
  onAbort: () => void
  controls: ReactNode
  canQuery: boolean
  settingsBusy: boolean
  error?: string
  onError: (error: string | undefined) => void
}) {
  const { creatingDraft, attachmentDraft, selectedSessionId, selectedSession, isDraft, draftProject, prompt, currentRun, history,
    setDraft, setDraftPrompt, status, isActive, submittingInput, steerQueued, planStatus, planPolicy,
    extensionStatus, planTurnId, retryHistory, setPendingJump } = state
  const promptTextareaRef = useComposerTextarea(prompt)
  useImperativeHandle(textareaRef, () => promptTextareaRef.current!)
  const promptHistory = useComposerHistory(
    selectedSessionId || (isDraft ? `draft:${draftProject?.key}` : ''),
    isDraft ? [] : timelineItems(history?.entries, currentRun?.turns ?? [], currentRun?.systemEvents ?? []),
    prompt,
    (value) => isDraft ? setDraftPrompt(value) : selectedSessionId && setDraft(selectedSessionId, value),
    promptTextareaRef,
  )
  useEffect(() => {
    if (!commands.notice?.running || commands.notice.cancelling) return
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.repeat) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return
      event.preventDefault()
      void commands.cancelCompact()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [commands])
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-transparent px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6" ref={setComposer} data-slot="composer">
      <div className="conversation-stage">
        <div className="conversation-stage-content">
          <div className="pointer-events-auto"><ExtensionUiInline sessionId={selectedSessionId} planTurnId={planTurnId} onViewPlan={() => { if (planTurnId) setPendingJump({ sessionId: selectedSessionId, turnId: planTurnId }) }} onRetryPlan={retryHistory} /></div>
          <PendingInputs inputs={(currentRun?.pendingInputs ?? []).filter((input) => !currentRun?.turns.some((turn) => (turn.steering?.queuedInputId === input.id || input.submissionId && turn.submissionId === input.submissionId && turn.steering) && turn.steering?.status !== 'failed'))} key={selectedSessionId} onResume={(inputId) => { void sessionRuns.resumeQueued(selectedSessionId, inputId).catch((cause) => onError(cause.message)) }} onSteer={steerQueued} disabled={submittingInput || status !== 'running'} />
          <ComposerAttachments draft={attachmentDraft} />
          {error && <p role="alert" className="pointer-events-auto mb-2 text-xs text-destructive">{error}<Button variant="ghost" size="sm" onClick={() => onError(undefined)}>关闭</Button></p>}
          <CommandNotice notice={commands.notice} />
          <div data-slot="message-composer" className="pointer-events-auto flex min-h-[100px] w-full flex-col justify-between gap-1 rounded-[2.5rem] border bg-muted px-5 py-3 shadow-sm dark:border-white/10 dark:bg-[#303030] sm:px-6">
        <label className="sr-only" htmlFor="prompt">{isDraft ? '输入新对话的第一条提示词' : '向当前 Pi 会话发送提示词'}</label>
        <CommandComposer
          onExecuteCommand={(value) => { if (attachmentDraft.items.length) onError('带附件时暂不支持命令，请先移除附件。'); else commands.submit(value) }}
          key={selectedSessionId || `draft:${draftProject?.key}`}
          sessionId={isDraft ? '' : selectedSessionId}
          sessionRuns={sessionRuns}
          canQuery={canQuery}
          className="min-h-0! shrink-0 resize-none border-0 bg-transparent px-0 py-0 text-[16px] leading-7 shadow-none placeholder:text-muted-foreground/70 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
          disabled={(!selectedSession && !isDraft) || creatingDraft}
          id="prompt"
          onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); try { attachmentDraft.add(files) } catch (cause) { onError(cause instanceof Error ? cause.message : '粘贴失败') } } }}
          maxLength={20_000}
          onFocus={(event) => resizeComposerTextarea(event.currentTarget)}
          onValueChange={(value) => {
            promptHistory.reset()
            if (isDraft) setDraftPrompt(value)
            else if (selectedSessionId) setDraft(selectedSessionId, value)
          }}
          onKeyDown={(event) => {
            if (commands.busy && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); return }
            if (promptHistory.onKeyDown(event)) return
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return

            event.preventDefault()
            onSubmit(event.ctrlKey ? 'steer' : 'follow_up')
          }}
          placeholder={isDraft ? '随心输入…' : status === 'running' ? 'Enter 排队，Ctrl + Enter 引导，Shift + Enter 换行' : 'Enter 发送，Shift + Enter 换行'}
          textareaRef={promptTextareaRef}
          rows={1}
          style={{ lineHeight: '1.75rem' }}
          value={prompt}
        />
        <div className="composer-toolbar flex min-h-9 shrink-0 flex-nowrap items-center gap-2">
          <AttachmentPicker draft={attachmentDraft} onError={onError} />
          {planStatus && <DropdownMenu><DropdownMenuTrigger asChild><Button aria-label="查看 Plan 模式详情" data-composer-tooltip={planStatus} className="composer-plan text-xs text-muted-foreground" size="sm" type="button" variant="ghost"><ListChecks aria-hidden="true" className="composer-control-icon hidden" /><span className="composer-control-label truncate">{planStatus}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="start" side="top" className="max-w-xs"><p className="px-2 py-1.5 text-sm font-normal">{planStatus}</p><p className="px-2 pb-2 text-xs text-muted-foreground">{planPolicy ?? '当前阶段未提供工具列表。'}</p></DropdownMenuContent></DropdownMenu>}
          {extensionStatus && <DropdownMenu><DropdownMenuTrigger asChild><Button aria-label={`扩展状态：${extensionStatus}`} data-composer-tooltip={extensionStatus} className="composer-extension text-xs text-muted-foreground" size="sm" type="button" variant="ghost"><Puzzle aria-hidden="true" className="composer-control-icon hidden" /><span className="composer-control-label min-w-0 truncate">{extensionStatus}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="start" side="top" className="max-w-xs"><p className="px-2 py-1.5 text-xs whitespace-pre-wrap break-words">{extensionStatus}</p></DropdownMenuContent></DropdownMenu>}
          <div className="composer-actions ml-auto flex min-w-0 items-center gap-2">
            {controls}
            {isActive && status !== 'aborting' && <Button aria-label="停止生成" className="rounded-full" onClick={() => void onAbort()} size="icon-lg" type="button" variant="destructive"><Square aria-hidden="true" /></Button>}
            {status === 'aborting' && <span role="status" aria-label="正在停止" data-composer-tooltip="正在停止…" className="composer-aborting inline-flex h-9 shrink-0 items-center text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="composer-control-icon hidden animate-spin" /><span className="composer-control-label">正在停止…</span></span>}
            {status === 'running' && (prompt.trim().length > 0 || attachmentDraft.items.length > 0) && <Button className="composer-queue rounded-full" disabled={submittingInput || commands.busy || attachmentDraft.busy} onClick={() => onSubmit()} aria-label={submittingInput ? '提交中' : parseComposerCommand(prompt) ? '执行命令' : '排队'} data-composer-tooltip={submittingInput ? '正在提交' : parseComposerCommand(prompt) ? '执行输入的命令' : '当前任务完成后执行'} type="button">{submittingInput ? <LoaderCircle aria-hidden="true" className="composer-control-icon hidden animate-spin" /> : parseComposerCommand(prompt) ? <Terminal aria-hidden="true" className="composer-control-icon hidden" /> : <ListPlus aria-hidden="true" className="composer-control-icon hidden" />}<span className="composer-control-label">{submittingInput ? '提交中…' : parseComposerCommand(prompt) ? '执行命令' : '排队'}</span></Button>}
            {!isActive && (
              <Button aria-label="发送提示词" className="rounded-full" disabled={commands.busy || (!selectedSession && !isDraft) || creatingDraft || settingsBusy || attachmentDraft.busy || (prompt.trim().length === 0 && attachmentDraft.items.length === 0)} onClick={() => onSubmit()} size="icon-lg" type="button"><Send aria-hidden="true" /></Button>
            )}
          </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function PendingInputs({ inputs, onSteer, onResume, disabled = false }: { inputs: PendingInput[]; onResume?: (inputId: string) => void; onSteer?: (inputId: string) => void; disabled?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const pending = inputs.filter((input) => input.mode === 'follow_up' || input.mode === 'steer' && input.attachments?.length)
  if (pending.length === 0) return null
  return <section aria-label="待处理消息" aria-live="polite" className="pointer-events-auto mb-2 rounded-xl border bg-background/95 px-3 py-2 text-xs">
    <ul className="max-h-32 space-y-1 overflow-y-auto">{(expanded ? pending : pending.slice(0, 2)).map((input) => <li className="flex min-w-0 items-center gap-2" key={input.id}><span className="shrink-0 text-muted-foreground">{input.submitting ? '正在提交' : input.mode === 'steer' ? '引导待生效' : '已排队'}</span><span className={expanded ? 'min-w-0 flex-1 whitespace-pre-wrap break-words' : 'min-w-0 flex-1 truncate'} title={input.message}>{input.message}{input.attachments?.length ? ` · ${input.attachments.length} 个附件` : ''}</span>{input.recoveryRequired && onResume ? <Button type="button" size="sm" variant="outline" onClick={() => onResume(input.id)}>确认继续</Button> : input.mode === 'follow_up' && onSteer && <Button className="h-auto shrink-0 px-2 py-1 text-xs" disabled={disabled || input.submitting} onClick={() => onSteer(input.id)} type="button" variant="ghost">引导</Button>}</li>)}</ul>
    {pending.length > 2 && <Button className="mt-1 h-auto p-0 text-xs text-muted-foreground" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} type="button" variant="ghost">{expanded ? '收起' : `还有 ${pending.length - 2} 条`}</Button>}
  </section>
}
