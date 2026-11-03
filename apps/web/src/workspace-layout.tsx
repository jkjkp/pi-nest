import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
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
  const navigationCollapsed = useWorkspaceStore((state) => state.navigationCollapsed)
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
  const previousCollapsed = useRef(navigationCollapsed)
  useLayoutEffect(() => {
    if (previousCollapsed.current === navigationCollapsed) return
    previousCollapsed.current = navigationCollapsed
    if (!window.matchMedia('(min-width: 48rem)').matches) return
    const selector = navigationCollapsed ? '[data-navigation-restore] button' : '#workspace-navigation button[aria-controls="workspace-navigation"]'
    containerRef.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true })
  }, [navigationCollapsed, containerRef])
  const displayedNavigationWidth = navigationCollapsed ? 0 : clampSidebarWidth(navigationWidth, availableWidth, 'navigation')
  const previewWidth = useWorkspaceStore((state) => state.inspectorWidth)
  return <main className="relative flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-card px-3 sm:px-4 md:hidden">
      <div className="flex min-w-0 items-center gap-2">
        <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
          <SheetTrigger asChild>
            <Button aria-label="打开会话导航" className="md:hidden" size="icon-sm" variant="ghost"><Menu aria-hidden="true" /></Button>
          </SheetTrigger>
          <SheetContent className="inset-y-2 left-2 rounded-lg p-0 [&>button:last-child]:hidden" side="left">
            <SheetTitle className="sr-only">会话导航</SheetTitle>
            <SheetDescription className="sr-only">选择要查看的 Pi 原生会话。</SheetDescription>
            <div id="workspace-navigation-mobile" className="min-h-0 flex-1">{navigation}</div>
          </SheetContent>
        </Sheet>
        <h1 className="truncate text-sm font-normal tracking-tight" title={titleTooltip}>{title}</h1>
      </div>
    </header>
    <div className="workspace-grid grid min-h-0 flex-1" ref={containerRef} style={{
      '--inspector-width': `${previewWidth}px`,
      '--navigation-width': `${displayedNavigationWidth}px`,
      '--side-panel-width': previewOpen ? `min(${Number.isFinite(previewWidth) ? previewWidth : 300}px, calc((100% - var(--navigation-width)) / 2))` : '0px',
    } as CSSProperties}>
      <aside id="workspace-navigation" aria-hidden={navigationCollapsed} inert={navigationCollapsed} className={`relative hidden min-h-0 min-w-0 md:block ${navigationCollapsed ? 'overflow-hidden' : 'p-2'}`}><div className={`${navigationCollapsed ? 'hidden' : ''} h-full min-h-0 overflow-hidden rounded-lg border bg-card/60`}>{navigation}</div>{!navigationCollapsed && <SidebarResizeHandle panel="navigation" containerRef={containerRef} width={navigationWidth} onWidthChange={setNavigationWidth} />}</aside>
      {children}
      {preview}
    </div>
  </main>
}
