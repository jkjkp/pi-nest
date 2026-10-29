import type { RefObject } from 'react'
import type { useWorkspaceFilePreview } from './use-workspace-file-preview.js'
import { PanelRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { ProjectFilesTree } from './project-files-tree.js'
import { filePreviewKey, fileTabKey } from './file-preview-state.js'
import { SidebarResizeHandle } from './sidebar-resize-handle.js'
import { SessionFilePreview } from './session-file-preview.js'
import { useWorkspaceStore } from './workspace-store.js'

type Preview = ReturnType<typeof useWorkspaceFilePreview>

export function WorkspaceFilePreviewToggle({ open, onToggle, buttonRef }: {
  open: boolean
  onToggle: () => void
  buttonRef: RefObject<HTMLButtonElement | null>
}) {
  return <Button ref={buttonRef} className="appearance-none border-0 shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-label={open ? '收起文件预览' : '打开文件预览'} aria-expanded={open} onClick={onToggle} size="icon-sm" type="button" variant="ghost"><PanelRight aria-hidden="true" /></Button>
}

export function WorkspaceFilePreview({ preview, containerRef }: { preview: Preview; containerRef: RefObject<HTMLDivElement | null> }) {
  const width = useWorkspaceStore((state) => state.inspectorWidth)
  const setWidth = useWorkspaceStore((state) => state.setInspectorWidth)
  const navigationWidth = useWorkspaceStore((state) => state.navigationWidth)
  const { sessionId, panel, scope, selection, open, wide } = preview
  const select = useWorkspaceStore(state => state.selectFileTab)
  const closeTab = useWorkspaceStore(state => state.closeFileTab)
  const visible = open
  const content = open && <div data-workspace-files className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-1 border-b p-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="文件标签">
        <Button variant="ghost" size="sm" aria-pressed={!selection} onClick={() => select(sessionId)}>项目文件</Button>
        {panel?.tabs.map(file => <div key={fileTabKey(file)} className={`flex shrink-0 items-center rounded-md ${file === selection ? 'bg-muted' : ''}`}>
          <Button variant="ghost" size="sm" title={file.path} aria-pressed={file === selection} className="max-w-40 truncate" onClick={() => select(sessionId, fileTabKey(file))}>{file.path.split(/[\\/]/).at(-1)}</Button>
          <Button variant="ghost" size="icon-sm" aria-label={`关闭 ${file.path}`} onClick={() => closeTab(sessionId, fileTabKey(file))}><X className="size-3" /></Button>
        </div>)}
      </div>
      <Button className="appearance-none border-0 shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" variant="ghost" size="icon-sm" aria-label="收起项目文件" onClick={preview.close}><PanelRight /></Button>
    </div>
    {scope && <div className={selection ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}><ProjectFilesTree key={sessionId} scope={scope} scopeKey={sessionId} cwd={preview.cwd} onOpenFile={path => preview.openFile(path, undefined, undefined, true)} /></div>}
    {selection ? <SessionFilePreview key={filePreviewKey(sessionId, selection.path, selection.searchRoot)} sessionId={sessionId} path={selection.path} searchRoot={selection.searchRoot} line={selection.line} navigation={selection.navigation} scope={selection.workspace || scope?.kind === 'project' ? scope : undefined} onClose={preview.close} onOpenFile={(path, line) => preview.openFile(path, line, selection.searchRoot, selection.workspace)} /> : !scope ? <p className="p-4 text-sm text-muted-foreground">请先选择项目。</p> : null}
  </div>
  return <>
    {!wide && <Sheet open={open} onOpenChange={preview.setOpen}>
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
      {visible && <SidebarResizeHandle panel="preview" containerRef={containerRef} navigationWidth={navigationWidth} width={width} onWidthChange={setWidth} />}
      <div className="h-full min-h-0 overflow-hidden">{wide && content}</div>
    </aside>
  </>
}
