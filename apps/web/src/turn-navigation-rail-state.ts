export const railWindowSize = 10
export const railRowHeight = 28

export function railWindowStart(count: number, currentIndex: number) {
  const lastWindow = Math.max(0, count - railWindowSize)
  return currentIndex >= lastWindow ? lastWindow : Math.max(0, Math.min(lastWindow, currentIndex - 4))
}

export function railScrollWindow(count: number, rowHeight: number, scrollTop: number, scrollHeight: number, clientHeight: number) {
  return {
    start: Math.max(0, Math.min(Math.max(0, count - railWindowSize), rowHeight > 0 ? Math.round(scrollTop / rowHeight) : 0)),
    moreAbove: scrollTop > 1,
    moreBelow: scrollHeight - scrollTop - clientHeight > 1,
  }
}

export function railAlignedOffset(scrollTop: number, rowHeight: number, maximum: number) {
  return rowHeight > 0 ? Math.max(0, Math.min(maximum, Math.round(scrollTop / rowHeight) * rowHeight)) : 0
}
