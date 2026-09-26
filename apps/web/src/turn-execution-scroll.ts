export function shouldExecutionFollowLatest(scrollHeight: number, scrollTop: number, clientHeight: number) {
  return scrollHeight - scrollTop - clientHeight <= 40
}
