export type TurnJumpAlignment = 'end' | 'start'

export function prependedScrollTop(beforeScrollHeight: number, beforeScrollTop: number, afterScrollHeight: number) {
  return beforeScrollTop + afterScrollHeight - beforeScrollHeight
}
