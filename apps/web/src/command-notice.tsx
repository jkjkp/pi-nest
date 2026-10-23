export function CommandNotice({ notice }: { notice?: { message: string; error?: boolean; running?: boolean } }) {
  if (!notice) return null
  if (notice.running) return <p role="status" aria-atomic="true" className="pointer-events-auto mb-2 px-4 text-xs text-muted-foreground"><span className="command-running">{notice.message}</span></p>
  return notice.error
    ? <div role="alert" aria-atomic="true" className="pointer-events-auto fixed top-5 left-1/2 z-50 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-destructive/30 bg-popover px-4 py-3 text-sm break-words text-destructive shadow-lg">{notice.message}</div>
    : <p role="status" className="pointer-events-auto mb-2 px-4 text-xs text-muted-foreground">{notice.message}</p>
}
