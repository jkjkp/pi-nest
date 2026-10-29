import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorkspaceFileScope } from '@pi-nest/contracts'
import { fileTabKey } from './file-preview-state.js'
import { useWorkspaceStore } from './workspace-store.js'

export function useWorkspaceFilePreview(sessionId: string, beforeLayoutChange: () => void, afterLayoutChange: () => void, context?: { scope?: WorkspaceFileScope; cwd?: string }) {
  const panel = useWorkspaceStore((state) => state.filePreviews[sessionId])
  const openFilePreview = useWorkspaceStore((state) => state.openFilePreview)
  const setFilePreviewOpen = useWorkspaceStore((state) => state.setFilePreviewOpen)
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 80rem)').matches)
  const openers = useRef(new Map<string, HTMLElement>())
  const toggleRef = useRef<HTMLButtonElement>(null)
  const open = panel?.open ?? false
  const selection = panel?.tabs.find(file => fileTabKey(file) === panel.activeTab)
  const scope = context?.scope ?? (sessionId && sessionId !== 'home' && !sessionId.startsWith('project:') ? { kind: 'session' as const, id: sessionId } : undefined)

  useEffect(() => {
    const media = window.matchMedia('(min-width: 80rem)')
    const update = () => setWide(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useLayoutEffect(afterLayoutChange, [open, wide, afterLayoutChange])

  const openFile = useCallback((path: string, line?: number, searchRoot?: string, workspace = false) => {
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('[data-workspace-files]')) openers.current.set(sessionId, document.activeElement)
    if (!open) beforeLayoutChange()
    const root = context?.cwd?.replaceAll('\\', '/').replace(/\/$/, '')
    const normalized = path.replaceAll('\\', '/')
    if (root && (!searchRoot || searchRoot.replaceAll('\\', '/') === root) && normalized.startsWith(`${root}/`)) {
      path = normalized.slice(root.length + 1)
      searchRoot = undefined
      workspace = true
    }
    openFilePreview(sessionId, path, line, searchRoot, workspace)
  }, [sessionId, openFilePreview, open, beforeLayoutChange, context?.cwd])
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
    beforeLayoutChange()
    setOpen(false)
    if (wide) restoreFocus()
  }
  return { sessionId, panel, scope, cwd: context?.cwd, selection, open, wide, toggleRef, toggle, close, setOpen, openFile, restoreFocus }
}

