export function nextOutlineAutoFollow(pendingUserJumpTurnId: string | undefined, currentTurnId: string) {
  return pendingUserJumpTurnId
    ? { pendingUserJumpTurnId: pendingUserJumpTurnId === currentTurnId ? undefined : pendingUserJumpTurnId, shouldFollow: false }
    : { pendingUserJumpTurnId, shouldFollow: true }
}

export function railHeight(turnCount: number) {
  return Math.min(360, Math.max(120, 80 + turnCount * 12))
}

export function markerHitHeight(turnCount: number) {
  return turnCount < 2 ? 20 : Math.min(20, railHeight(turnCount) * 0.75 / (turnCount - 1))
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
