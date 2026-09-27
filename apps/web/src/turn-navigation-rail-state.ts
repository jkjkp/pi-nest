export type RailMode = 'detailed' | 'compact' | 'density'

export const railTopSafeInset = 20
export const railBottomSafeInset = 28
export const railIdleHeight = 144
export const railExpandedMaxHeight = 220
export const outlineMaxHeight = 420

export type RailViewportLayout = { bottom: number; height: number; top: number }

function computeViewportLayout({ bottomInset, desiredHeight, idealCenter, topInset, viewportHeight }: {
  bottomInset: number
  desiredHeight: number
  idealCenter: number
  topInset: number
  viewportHeight: number
}): RailViewportLayout {
  const height = Math.max(0, viewportHeight)
  const safeTop = Math.min(topInset, height)
  const safeBottom = Math.min(bottomInset, height - safeTop)
  const layoutHeight = Math.min(desiredHeight, Math.max(0, height - safeTop - safeBottom))
  const top = Math.max(safeTop, Math.min(height - safeBottom - layoutHeight, idealCenter - layoutHeight / 2))
  return { bottom: top + layoutHeight, height: layoutHeight, top }
}

export function computeRailViewportLayout({
  bottomInset = railBottomSafeInset,
  maxHeight = railExpandedMaxHeight,
  minHeight = 140,
  preferredRatio = 0.3,
  topInset = railTopSafeInset,
  viewportHeight,
}: {
  bottomInset?: number
  maxHeight?: number
  minHeight?: number
  preferredRatio?: number
  topInset?: number
  viewportHeight: number
}): RailViewportLayout {
  const preferredHeight = Math.min(maxHeight, Math.max(minHeight, Math.max(0, viewportHeight) * preferredRatio))
  return computeViewportLayout({ bottomInset, desiredHeight: preferredHeight, idealCenter: Math.max(0, viewportHeight) / 2, topInset, viewportHeight })
}

export function computeIdleRailViewportLayout({
  bottomInset = railBottomSafeInset,
  height = railIdleHeight,
  topInset = railTopSafeInset,
  viewportHeight,
}: {
  bottomInset?: number
  height?: number
  topInset?: number
  viewportHeight: number
}): RailViewportLayout {
  return computeViewportLayout({ bottomInset, desiredHeight: height, idealCenter: Math.max(0, viewportHeight) / 2, topInset, viewportHeight })
}

export function computeOutlineViewportLayout({
  bottomInset = railBottomSafeInset,
  centerY,
  maxHeight = outlineMaxHeight,
  topInset = railTopSafeInset,
  viewportHeight,
}: {
  bottomInset?: number
  centerY: number
  maxHeight?: number
  topInset?: number
  viewportHeight: number
}): RailViewportLayout {
  return computeViewportLayout({ bottomInset, desiredHeight: maxHeight, idealCenter: centerY, topInset, viewportHeight })
}

export function railMode(turnCount: number): RailMode {
  return turnCount <= 40 ? 'detailed' : turnCount <= 200 ? 'compact' : 'density'
}

export function turnRatio(index: number, turnCount: number) {
  return turnCount <= 1 ? 0.5 : Math.max(0, Math.min(1, index / (turnCount - 1)))
}

export function railIndexFromPointer(pointerY: number, rail: Pick<DOMRect, 'height' | 'top'>, turnCount: number) {
  if (turnCount < 2 || rail.height <= 0) return 0
  return Math.max(0, Math.min(turnCount - 1, Math.round(((pointerY - rail.top) / rail.height) * (turnCount - 1))))
}

export function focusWindow(activeIndex: number, turnCount: number, radius = 4) {
  const first = Math.max(0, activeIndex - radius)
  const last = Math.min(turnCount - 1, activeIndex + radius)
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

export function densityBins(turnCount: number, maxBins = 64) {
  const binCount = Math.min(maxBins, turnCount)
  return Array.from({ length: binCount }, (_, index) => {
    const start = Math.floor((index * turnCount) / binCount)
    const end = Math.floor(((index + 1) * turnCount) / binCount)
    return { count: end - start, endRatio: turnRatio(Math.max(start, end - 1), turnCount), startRatio: turnRatio(start, turnCount) }
  })
}

export function nextRailIndex(key: string, currentIndex: number, turnCount: number) {
  if (key === 'Home') return 0
  if (key === 'End') return Math.max(0, turnCount - 1)
  if (key === 'ArrowUp' || key === 'ArrowLeft') return Math.max(0, currentIndex - 1)
  if (key === 'ArrowDown' || key === 'ArrowRight') return Math.min(turnCount - 1, currentIndex + 1)
  return undefined
}

export function nextOutlineAutoFollow(pendingUserJumpTurnId: string | undefined, currentTurnId: string) {
  return pendingUserJumpTurnId
    ? { pendingUserJumpTurnId: pendingUserJumpTurnId === currentTurnId ? undefined : pendingUserJumpTurnId, shouldFollow: false }
    : { pendingUserJumpTurnId, shouldFollow: true }
}

export function openOutlineFromContextMenu(event: Pick<MouseEvent, 'preventDefault'>, openOutline: () => void) {
  event.preventDefault()
  openOutline()
}

export function jumpFromMarker(onJump: (turnId: string) => void, turnId: string) {
  onJump(turnId)
}

export function jumpFromOutline(onJump: (turnId: string) => void, closeOutline: () => void, turnId: string) {
  onJump(turnId)
  closeOutline()
}
