export type TurnJumpAlignment = 'end' | 'start'

export function prependedScrollTop(beforeScrollHeight: number, beforeScrollTop: number, afterScrollHeight: number) {
  return beforeScrollTop + afterScrollHeight - beforeScrollHeight
}

export function turnJumpAlignment(turnId: string, lastTurnId: string | undefined): TurnJumpAlignment {
  return turnId === lastTurnId ? 'end' : 'start'
}
