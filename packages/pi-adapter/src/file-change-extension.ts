import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPackageDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { FileChangeTracker } from './file-change-tracker.js'

/** Runs in Pi before mutations; asynchronous RPC notifications are too late to take baselines. */
export default async function fileChangeExtension(pi: ExtensionAPI) {
  // Reuse the pinned Pi resolver, including ~, @ prefixes and Windows shell paths.
  const { resolveToCwd } = await import(pathToFileURL(join(getPackageDir(), 'dist/core/tools/path-utils.js')).href) as { resolveToCwd: (path: string, cwd: string) => string }
  const tracker = new FileChangeTracker()
  const calls = new Map<string, string>()
  let turnId: string | undefined
  let dirty = false
  function reset() { tracker.reset(); calls.clear(); turnId = undefined; dirty = false }
  function flush() {
    if (!dirty) return
    const files = tracker.finish()
    dirty = false
    if (turnId && files.length) pi.appendEntry('pi-nest-file-changes', { version: 1, turnId, files })
  }
  pi.on('session_start', reset)
  pi.on('session_shutdown', () => { flush(); reset() })
  pi.on('agent_settled', () => { flush(); reset() })
  pi.on('message_start', ({ message }) => { if (message.role === 'user') { flush(); reset() } })
  pi.on('tool_call', (event, context) => {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return
    if (!('path' in event.input) || typeof event.input.path !== 'string') return
    turnId ??= context.sessionManager.getBranch().findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id
    dirty = true
    calls.set(event.toolCallId, tracker.before(context.cwd, resolveToCwd(event.input.path, context.cwd)))
  })
  pi.on('tool_result', (event, context) => {
    const path = calls.get(event.toolCallId)
    calls.delete(event.toolCallId)
    if (!path) return
    dirty = true
    // Later extensions may rewrite arguments; never attach a baseline for a different file.
    const resolved = typeof event.input.path === 'string' ? resolveToCwd(event.input.path, context.cwd) : undefined
    if (!resolved) return
    if (resolved !== path) tracker.invalidate(resolved)
    const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details) ? event.details : {}
    return { details: { ...details, piNestFileChange: tracker.record(resolved, !event.isError) } }
  })
}
