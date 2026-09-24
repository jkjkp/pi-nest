export function promptOverflows(scrollHeight: number, clientHeight: number) {
  return scrollHeight > clientHeight + 1
}
