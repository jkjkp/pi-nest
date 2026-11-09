import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

export const COMPOSER_TEXTAREA_MAX_HEIGHT = 196

function pixels(value: string) {
  return Number.parseFloat(value) || 0
}

const wrappingProperties = [
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'overflow-wrap', 'word-break',
  'tab-size', 'text-indent', 'text-transform', 'direction',
]

export function isComposerCaretAtRowBoundary(textarea: HTMLTextAreaElement, value: string, direction: 'up' | 'down') {
  const caret = textarea.selectionStart
  const up = direction === 'up'
  const edge = up ? 0 : value.length
  if (caret === edge) return true
  if ((up ? value.slice(0, caret) : value.slice(caret)).includes('\n')) return false
  if (!textarea.clientWidth) return true

  const document = textarea.ownerDocument
  const style = document.defaultView!.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  mirror.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;box-sizing:content-box'
  mirror.style.width = `${textarea.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight)}px`
  for (const property of wrappingProperties) mirror.style.setProperty(property, style.getPropertyValue(property))
  // Keep the text in one node so measuring the caret does not change wrapping.
  const text = document.createTextNode(value)
  mirror.append(text)
  document.body.append(mirror)
  try {
    const range = document.createRange()
    range.setStart(text, caret)
    const caretRects = Array.from(range.getClientRects())
    range.setStart(text, edge)
    range.collapse(true)
    const edgeTop = range.getClientRects()[0]?.top
    // shortcut: a shared wrap offset can belong to either row, so let native navigation resolve it.
    return edgeTop !== undefined && caretRects.length > 0 && caretRects.every((rect) => Math.abs(rect.top - edgeTop) < 1)
  } finally {
    mirror.remove()
  }
}

export function resizeComposerTextarea(textarea: HTMLTextAreaElement, maxHeight = COMPOSER_TEXTAREA_MAX_HEIGHT) {
  const style = getComputedStyle(textarea)
  const borderHeight = pixels(style.borderTopWidth) + pixels(style.borderBottomWidth)
  const minimumHeight = pixels(style.lineHeight) + pixels(style.paddingTop) + pixels(style.paddingBottom) + borderHeight

  const scrollTop = textarea.scrollTop
  textarea.style.height = 'auto'
  const contentHeight = textarea.scrollHeight + borderHeight
  const height = Math.min(maxHeight, Math.max(minimumHeight, contentHeight))
  textarea.style.height = `${height}px`
  textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
  textarea.scrollTop = scrollTop
}

export function useComposerTextarea(value: string, maxHeight = COMPOSER_TEXTAREA_MAX_HEIGHT) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const resize = useCallback(() => {
    if (ref.current) resizeComposerTextarea(ref.current, maxHeight)
  }, [maxHeight])

  useLayoutEffect(resize, [resize, value])

  useEffect(() => {
    let frame: number | undefined
    const scheduleResize = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        resize()
      })
    }

    window.addEventListener('resize', scheduleResize)
    return () => {
      window.removeEventListener('resize', scheduleResize)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [resize])

  return ref
}
