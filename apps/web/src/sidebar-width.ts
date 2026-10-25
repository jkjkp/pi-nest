export type SidebarPanel = 'navigation' | 'preview'

export function maximumSidebarWidth(available: number, panel: SidebarPanel) {
  return Math.max(0, panel === 'navigation' ? Math.min(480, Math.floor(available - 360)) : Math.floor(available / 2))
}

export function clampSidebarWidth(width: number, available: number, panel: SidebarPanel) {
  const max = maximumSidebarWidth(available, panel)
  const minimum = panel === 'navigation' ? 220 : 240
  const fallback = panel === 'navigation' ? 272 : 300
  return Math.max(Math.min(minimum, max), Math.min(max, Number.isFinite(width) ? width : fallback))
}

