export type TimelineJump = { id: number; sessionId: string; revision?: string; turnId: string; phase: 'loading' | 'locating' }
export const timelineReadingOffset = 48

export type TimelineReadingPosition = { atBottom: boolean; turnId?: string; offset: number; scrollTop: number }
export type TimelineScrollController = {
  sessionId: string
  capture: () => Omit<TimelineReadingPosition, 'atBottom'> | undefined
  restore: (position: TimelineReadingPosition) => 'pending' | 'restored' | 'missing'
  cancelJump?: () => void
}
