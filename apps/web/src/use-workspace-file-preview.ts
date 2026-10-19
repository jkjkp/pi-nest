import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from './workspace-store.js'

export function useWorkspaceFilePreview(sessionId: string, beforeLayoutChange: () => void, afterLayoutChange: () => void) {
  const selection = useWorkspaceStore((state) => state.filePreviews[sessionId])
  const openFilePreview = useWorkspaceStore((state) => state.openFilePreview)
  const setFilePreviewOpen = useWorkspaceStore((state) => state.setFilePreviewOpen)
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 80rem)').matches)
  const openers = useRef(new Map<string, HTMLElement>())
  const toggleRef = useRef<HTMLButtonElement>(null)
  const open = selection?.open ?? false

  useEffect(() => {
    const media = window.matchMedia('(min-width: 80rem)')
    const update = () => setWide(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useLayoutEffect(afterLayoutChange, [open, wide, afterLayoutChange])

  const openFile = useCallback((path: string, line?: number, searchRoot?: string) => {
    if (document.activeElement instanceof HTMLElement) openers.current.set(sessionId, document.activeElement)
    openFilePreview(sessionId, path, line, searchRoot)
  }, [sessionId, openFilePreview])
  function restoreFocus() {
    const opener = openers.current.get(sessionId)
    if (opener?.isConnected) opener.focus({ preventScroll: true })
    else toggleRef.current?.focus({ preventScroll: true })
  }
  function setOpen(value: boolean) { setFilePreviewOpen(sessionId, value) }
  function toggle() {
    beforeLayoutChange()
    setOpen(!open)
  }
  function close() {
    setOpen(false)
    if (wide) restoreFocus()
  }
  return { sessionId, selection, open, wide, toggleRef, toggle, close, setOpen, openFile, restoreFocus }
}

