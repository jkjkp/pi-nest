import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { SidebarResizeHandle } from './sidebar-resize-handle.js'
import { clampSidebarWidth } from './sidebar-width.js'
import { useWorkspaceStore } from './workspace-store.js'

export function WorkspaceLayout({ title, titleTooltip, navigation, preview, previewOpen, children, containerRef }: {
  title: string
  titleTooltip?: string
  navigation: ReactNode
  preview: ReactNode
  previewOpen: boolean
  children: ReactNode
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const navigationOpen = useWorkspaceStore((state) => state.navigationOpen)
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  const navigationWidth = useWorkspaceStore((state) => state.navigationWidth)
  const setNavigationWidth = useWorkspaceStore((state) => state.setNavigationWidth)
  const [availableWidth, setAvailableWidth] = useState(Infinity)
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => setAvailableWidth(container.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])
  const displayedNavigationWidth = clampSidebarWidth(navigationWidth, availableWidth, 'navigation')
  const previewWidth = useWorkspaceStore((state) => state.inspectorWidth)
  return <main className="relative flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-card px-3 sm:px-4 md:hidden">
      <div className="flex min-w-0 items-center gap-2">
        <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
          <SheetTrigger asChild>
            <Button aria-label="打开会话导航" className="md:hidden" size="icon-sm" variant="ghost"><Menu aria-hidden="true" /></Button>
          </SheetTrigger>
          <SheetContent className="inset-y-2 left-2 rounded-lg p-0" side="left">
            <SheetTitle className="sr-only">会话导航</SheetTitle>
            <SheetDescription className="sr-only">选择要查看的 Pi 原生会话。</SheetDescription>
            {navigation}
          </SheetContent>
        </Sheet>
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-xs font-normal text-primary-foreground">PN</span>
        <h1 className="truncate text-sm font-normal tracking-tight" title={titleTooltip}>{title}</h1>
      </div>
    </header>
    <div className="workspace-grid grid min-h-0 flex-1" ref={containerRef} style={{
      '--inspector-width': `${previewWidth}px`,
      '--navigation-width': `${displayedNavigationWidth}px`,
      '--side-panel-width': previewOpen ? `min(${Number.isFinite(previewWidth) ? previewWidth : 300}px, calc((100% - var(--navigation-width)) / 2))` : '0px',
    } as CSSProperties}>
      <aside className="relative hidden min-h-0 min-w-0 p-2 md:block"><div className="h-full min-h-0 overflow-hidden rounded-lg border bg-card/60">{navigation}</div><SidebarResizeHandle panel="navigation" containerRef={containerRef} width={navigationWidth} onWidthChange={setNavigationWidth} /></aside>
      {children}
      {preview}
    </div>
  </main>
}
