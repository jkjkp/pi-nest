import { isPiDialogMethod, piExtensionProjection, type PiExtensionProjection } from '@pi-nest/contracts/pi-events'
import type { PiRuntimeEvent } from '@pi-nest/contracts'
import { stripAnsiLine, stripAnsiText } from './ansi-text.js'

type ExtensionOption = {
  displayLabel: string
  rawValue: string
  kind?: 'custom_answer' | 'implement_here' | 'implement_fresh'
  menuLabel?: string
}
type DialogMethod = 'confirm' | 'editor' | 'input' | 'select'

export type ExtensionDialog = {
  id: string
  message?: string
  method: DialogMethod
  options?: ExtensionOption[]
  placeholder?: string
  prefill?: string
  selectedValue?: string
  runId?: string
  sessionId: string
  title: string
  value?: string
}

const implementationLabels: Record<string, string> = {
  'Implement here': '在当前会话执行',
  'Start fresh and implement': '新建会话执行',
}
const planMenuLabels: Record<string, string> = {
  'Export plan…': '导出计划',
  'Export plan...': '导出计划',
  'Save for later': '稍后保存',
  'Stay in Plan mode': '继续规划',
  'Discard plan and exit': '放弃计划并退出',
}

function extensionOption(rawValue: string, plan: boolean): ExtensionOption {
  const label = stripAnsiText(rawValue)
  const displayLabel = label.replace(/^[^\n]*/, (line) => Object.hasOwn(implementationLabels, line) ? implementationLabels[line]! : line)
  // Pi's Plan and questionnaire extensions currently identify these actions by text.
  if (plan && rawValue === 'Implement here') return { rawValue, displayLabel, kind: 'implement_here' }
  if (plan && rawValue === 'Start fresh and implement') return { rawValue, displayLabel, kind: 'implement_fresh' }
  if (/^\d+\. Other \(free-form\)$/.test(label)) return { rawValue, displayLabel, kind: 'custom_answer' }
  const menuLabel = plan && Object.hasOwn(planMenuLabels, label) ? planMenuLabels[label] : undefined
  return { rawValue, displayLabel, ...(menuLabel === undefined ? {} : { menuLabel }) }
}

export function isCustomAnswerEditor(question: Pick<ExtensionDialog, 'sessionId' | 'runId' | 'title'>, editor: Pick<ExtensionDialog, 'sessionId' | 'runId' | 'title' | 'method'>) {
  return editor.method === 'editor' && question.sessionId === editor.sessionId && question.runId === editor.runId && question.title.endsWith(`: ${editor.title}`)
}

export function isCustomAnswerSelection(dialog: Pick<ExtensionDialog, 'options' | 'selectedValue'>) {
  return dialog.options?.find((option) => option.rawValue === dialog.selectedValue)?.kind === 'custom_answer'
}

export function selectResponse(dialog: Pick<ExtensionDialog, 'selectedValue' | 'options' | 'value'>) {
  if (isCustomAnswerSelection(dialog) && !dialog.value?.trim()) return undefined
  return dialog.selectedValue === undefined ? undefined : { value: dialog.selectedValue }
}

export function isPlanImplementationOption(option: ExtensionOption) {
  return option.kind === 'implement_here' || option.kind === 'implement_fresh'
}

export function planActionOptions(dialog: Pick<ExtensionDialog, 'options'>) {
  const options = dialog.options ?? []
  const primary = options.filter(isPlanImplementationOption)
  if (primary.length !== 2) return undefined
  return { primary, more: options.filter((option) => !isPlanImplementationOption(option)) }
}

export function planImplementationPrompt(dialog: Pick<ExtensionDialog, 'options'>, response: { cancelled?: boolean; value?: string }) {
  if (response.cancelled || !dialog.options?.some((option) => option.kind === 'implement_fresh')) return undefined
  return dialog.options.some((option) => option.kind === 'implement_here' && option.rawValue === response.value) ? 'Implement the plan.' : undefined
}

export function dialogFrom(event: PiRuntimeEvent): ExtensionDialog | undefined {
  const value = event.event
  if (value.type !== 'extension_ui_request' || typeof value.id !== 'string' || !isPiDialogMethod(value.method)) return undefined
  const title = typeof value.title === 'string' ? stripAnsiLine(value.title) : 'Pi extension request'
  const plan = title.startsWith('Proposed plan ready.')
  const options = value.method === 'select' && Array.isArray(value.options)
    ? value.options.filter((item): item is string => typeof item === 'string').map((rawValue) => extensionOption(rawValue, plan))
    : undefined
  const prefill = typeof value.prefill === 'string' ? stripAnsiText(value.prefill) : undefined
  return {
    id: value.id, sessionId: event.sessionId, runId: event.runId, method: value.method,
    message: typeof value.message === 'string' ? stripAnsiLine(value.message) : undefined,
    options,
    placeholder: typeof value.placeholder === 'string' ? stripAnsiLine(value.placeholder) : undefined,
    prefill, selectedValue: options?.[0]?.rawValue,
    title,
    value: prefill ?? '',
  }
}

type ExtensionPresentation =
  | { kind: 'dialog'; dialog: ExtensionDialog }
  | { kind: 'dialog_closed'; dialogId: string }
  | { kind: 'title'; title: string }
  | { kind: 'questionnaire_error'; text: string }
  | { kind: 'notice'; text: string; level: 'info' | 'warning' | 'error' }

export function readExtensionPresentation(event: PiRuntimeEvent): ExtensionPresentation | undefined {
  const raw = event.event
  if (raw.type === 'extension_ui_resolved' && typeof raw.dialogId === 'string') return { kind: 'dialog_closed', dialogId: raw.dialogId }
  if (raw.type !== 'extension_ui_request') return
  const dialog = dialogFrom(event)
  if (dialog) return { kind: 'dialog', dialog }
  if (raw.method === 'setTitle' && typeof raw.title === 'string') return { kind: 'title', title: stripAnsiLine(raw.title) }
  if (raw.method === 'notify' && typeof raw.message === 'string') {
    const level = raw.notifyType === 'error' || raw.notifyType === 'warning' ? raw.notifyType : 'info'
    const text = stripAnsiLine(raw.message)
    if (/^Questionnaire failed:/i.test(text)) return { kind: 'questionnaire_error', text }
    if (text === 'Plan mode enabled. I will explore and plan, but not modify files.' || (level === 'info' && /^Ponytail loaded: (lite|full|ultra)$/.test(text))) return
    return { kind: 'notice', text, level }
  }
}

export function isExtensionProjectionEvent(event: PiRuntimeEvent) {
  return piExtensionProjection(event.event) !== undefined
}

export type ExtensionProjection = PiExtensionProjection | { kind: 'draft'; text: string }

export function readExtensionProjection(event: PiRuntimeEvent): ExtensionProjection | undefined {
  const raw = event.event
  if (raw.type !== 'extension_ui_request') return
  if (raw.method === 'set_editor_text' && typeof raw.text === 'string') return { kind: 'draft', text: stripAnsiText(raw.text) }
  return piExtensionProjection(raw)
}

export function extensionStatusLine(statuses: Record<string, string> | undefined) {
  return Object.keys(statuses ?? {})
    .filter((key) => key !== 'plan-mode')
    .sort()
    .map((key) => stripAnsiLine(statuses?.[key] ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

export function extensionWidgetText(widgets: Record<string, string[]> | undefined) {
  return Object.keys(widgets ?? {})
    .filter((key) => key !== 'plan-mode-plan')
    .sort()
    .map((key) => (widgets?.[key] ?? []).map(stripAnsiLine).join('\n').trim())
    .filter(Boolean)
    .join('\n\n')
}

export function planModePolicy(widgets: Record<string, string[]> | undefined) {
  return widgets?.['plan-mode-plan']?.map(stripAnsiLine).find((line) => line.startsWith('Plan policy allows:'))?.replace(' Model-visible tools stay unchanged.', '').trim()
}

export function planModeStatus(statuses: Record<string, string> | undefined) {
  return stripAnsiLine(statuses?.['plan-mode'] ?? '').trim()
}
