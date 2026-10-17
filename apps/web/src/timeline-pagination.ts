export type TurnJumpAlignment = 'end' | 'start'

export type TimelineReadingPosition = { atBottom: boolean; turnId?: string; offset: number; scrollTop: number }
export type TimelineScrollController = {
  sessionId: string
  capture: () => Omit<TimelineReadingPosition, 'atBottom'> | undefined
  restore: (position: TimelineReadingPosition) => 'pending' | 'restored' | 'missing'
}

export function prependedScrollTop(beforeScrollHeight: number, beforeScrollTop: number, afterScrollHeight: number) {
  return beforeScrollTop + afterScrollHeight - beforeScrollHeight
}
