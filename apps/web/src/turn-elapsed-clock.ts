export function nextElapsedTickDelay(startedAt: string, now = Date.now()) {
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started)) return 1_000
  const elapsed = Math.max(0, now - started)
  return Math.max(1, 1_000 - elapsed % 1_000)
}

export function startElapsedClock(startedAt: string, onTick: (now: number) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    timer = setTimeout(() => {
      onTick(Date.now())
      schedule()
    }, nextElapsedTickDelay(startedAt))
  }
  schedule()
  return () => {
    if (timer !== undefined) clearTimeout(timer)
  }
}
