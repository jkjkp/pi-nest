import {
  discoverPiSessionFiles,
  mapLimit,
  readPiSessionSummary,
  SUMMARY_CONCURRENCY,
  type PiSessionSummary,
} from './session-files.js'

export type { PiSessionSummary } from './session-files.js'

function modifiedTime(summary: PiSessionSummary) {
  const time = summary.updatedAt ? new Date(summary.updatedAt).getTime() : Number.NaN
  return Number.isNaN(time) ? 0 : time
}

/**
 * One-shot discovery used by scripts and diagnostics. The server keeps its own
 * shared index instead of calling this for each request.
 */
export async function listPiSessions(sessionsDirectory?: string): Promise<PiSessionSummary[]> {
  const discovery = await discoverPiSessionFiles(sessionsDirectory)
  const reads = await mapLimit(discovery.files, SUMMARY_CONCURRENCY, (file) => readPiSessionSummary(file))
  return reads
    .filter((read): read is NonNullable<typeof read> => read !== undefined)
    .map((read) => read.summary)
    .sort((left, right) => modifiedTime(right) - modifiedTime(left))
}
