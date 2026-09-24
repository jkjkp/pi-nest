import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

export const COMPOSER_TEXTAREA_MAX_HEIGHT = 196

function pixels(value: string) {
  return Number.parseFloat(value) || 0
}

export function resizeComposerTextarea(textarea: HTMLTextAreaElement, maxHeight = COMPOSER_TEXTAREA_MAX_HEIGHT) {
  const style = getComputedStyle(textarea)
  const borderHeight = pixels(style.borderTopWidth) + pixels(style.borderBottomWidth)
  const minimumHeight = pixels(style.lineHeight) + pixels(style.paddingTop) + pixels(style.paddingBottom) + borderHeight

  textarea.style.height = 'auto'
  const contentHeight = textarea.scrollHeight + borderHeight
  const height = Math.min(maxHeight, Math.max(minimumHeight, contentHeight))
  textarea.style.height = `${height}px`
  textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
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
