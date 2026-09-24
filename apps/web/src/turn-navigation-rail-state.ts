export function nextOutlineAutoFollow(pendingUserJumpTurnId: string | undefined, currentTurnId: string) {
  return pendingUserJumpTurnId
    ? { pendingUserJumpTurnId: pendingUserJumpTurnId === currentTurnId ? undefined : pendingUserJumpTurnId, shouldFollow: false }
    : { pendingUserJumpTurnId, shouldFollow: true }
}
