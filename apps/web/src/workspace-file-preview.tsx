import type { RefObject } from 'react'
import type { useWorkspaceFilePreview } from './use-workspace-file-preview.js'
import { PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { filePreviewKey } from './file-preview-state.js'
import { FilePreviewResizeHandle } from './file-preview-resize-handle.js'
import { SessionFilePreview } from './session-file-preview.js'
import { useWorkspaceStore } from './workspace-store.js'

type Preview = ReturnType<typeof useWorkspaceFilePreview>

export function WorkspaceFilePreviewToggle({ available, open, onToggle, buttonRef }: {
  available: boolean
  open: boolean
  onToggle: () => void
  buttonRef: RefObject<HTMLButtonElement | null>
}) {
  return available && <Button ref={buttonRef} aria-label={open ? '收起文件预览' : '打开文件预览'} aria-expanded={open} onClick={onToggle} size="icon-sm" type="button" variant="ghost"><PanelRight aria-hidden="true" /></Button>
}

export function WorkspaceFilePreview({ preview, isHome, containerRef }: { preview: Preview; isHome: boolean; containerRef: RefObject<HTMLDivElement | null> }) {
  const width = useWorkspaceStore((state) => state.inspectorWidth)
  const setWidth = useWorkspaceStore((state) => state.setInspectorWidth)
  const navigationWidth = useWorkspaceStore((state) => state.navigationWidth)
  const { sessionId, selection, open, wide } = preview
  const visible = !isHome && Boolean(selection) && open
  const content = selection && open ? <SessionFilePreview key={filePreviewKey(sessionId, selection.path, selection.searchRoot)} sessionId={sessionId} path={selection.path} searchRoot={selection.searchRoot} line={selection.line} navigation={selection.navigation} onClose={preview.close} onOpenFile={(path, line) => useWorkspaceStore.getState().openFilePreview(sessionId, path, line)} /> : null
  return <>
    {!wide && <Sheet open={open && Boolean(selection)} onOpenChange={preview.setOpen}>
      <SheetContent className="w-full p-0 sm:w-[min(40rem,100vw)] [&>button:last-child]:hidden" side="right" onCloseAutoFocus={(event) => {
        event.preventDefault()
        if (!window.matchMedia('(min-width: 80rem)').matches) preview.restoreFocus()
      }}>
        <SheetTitle className="sr-only">文件预览</SheetTitle>
        <SheetDescription className="sr-only">查看当前项目内的文件内容。</SheetDescription>
        {content}
      </SheetContent>
    </Sheet>}
    <aside aria-hidden={!visible} className={`relative hidden min-h-0 min-w-0 bg-card/60 xl:block ${visible ? 'border-l' : 'pointer-events-none'}`} inert={!visible}>
      {visible && <FilePreviewResizeHandle containerRef={containerRef} navigationWidth={navigationWidth} width={width} onWidthChange={setWidth} />}
      <div className="h-full min-h-0 overflow-hidden">{wide && content}</div>
    </aside>
  </>
}
