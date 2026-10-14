import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react'

type Message = { id: string; prompt?: string }
export type ComposerHistoryPosition = { id: string; draft: string; recalled: string }

export function moveComposerHistory(messages: Message[], position: ComposerHistoryPosition | undefined, value: string, direction: 'up' | 'down') {
  const history = messages.filter((message) => message.prompt?.trim())
  const index = position ? history.findIndex((message) => message.id === position.id) : history.length
  if (index < 0 || (direction === 'down' && !position)) return undefined
  const nextIndex = direction === 'up' ? index - 1 : index + 1
  if (nextIndex < 0) return undefined
  if (nextIndex === history.length) return { value: position!.draft, position: undefined }
  const message = history[nextIndex]!
  return { value: message.prompt!, position: { id: message.id, draft: position?.draft ?? value, recalled: message.prompt! } }
}

export function useComposerHistory(sessionKey: string, messages: Message[], value: string, setValue: (value: string) => void, textarea: RefObject<HTMLTextAreaElement | null>) {
  const state = useRef<{ sessionKey: string; position?: ComposerHistoryPosition }>({ sessionKey })
  const pendingCaret = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    if (state.current.sessionKey !== sessionKey || (state.current.position && state.current.position.recalled !== value)) {
      state.current = { sessionKey }
      pendingCaret.current = undefined
    }
    if (pendingCaret.current === undefined) return
    if (pendingCaret.current === value) textarea.current?.setSelectionRange(value.length, value.length)
    pendingCaret.current = undefined
  }, [sessionKey, value, textarea])

  function reset() {
    state.current = { sessionKey }
    pendingCaret.current = undefined
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (state.current.sessionKey !== sessionKey || (state.current.position && state.current.position.recalled !== value)) reset()
    if (!sessionKey || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return false
    const input = event.currentTarget
    if (input.selectionStart !== input.selectionEnd) return false
    const position = state.current.position
    const up = event.key === 'ArrowUp'
    if (up ? input.selectionStart !== 0 && !(position && input.selectionStart === value.length) : input.selectionStart !== value.length) return false
    const next = moveComposerHistory(messages, position, value, up ? 'up' : 'down')
    if (!next) {
      if (position && up) event.preventDefault()
      return Boolean(position && up)
    }
    event.preventDefault()
    state.current.position = next.position
    pendingCaret.current = next.value
    setValue(next.value)
    // Identical consecutive messages do not trigger a value update.
    if (next.value === value) {
      input.setSelectionRange(value.length, value.length)
      pendingCaret.current = undefined
    }
    return true
  }

  return { onKeyDown, reset }
}
