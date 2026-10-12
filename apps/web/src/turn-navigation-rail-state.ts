export const railWindowSize = 10
export const railRowHeight = 28

export function railWindowStart(count: number, currentIndex: number) {
  const lastWindow = Math.max(0, count - railWindowSize)
  return currentIndex >= lastWindow ? lastWindow : Math.max(0, Math.min(lastWindow, currentIndex - 4))
}
