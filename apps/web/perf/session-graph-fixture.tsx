import { seedWorkspaceProjects } from '../src/test-fixtures/workspace.js'
import './style.css'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { WorkspacePage } from '../src/workspace-page.js'
import { TooltipProvider } from '../src/components/ui/tooltip.js'
import { createSessionRunController } from '../src/session-run-controller.js'
import { useWorkspaceStore } from '../src/workspace-store.js'
import { runtimeFixture } from './runtime-fixture.js'
import type { PiSessionSummary } from '@pi-nest/contracts'

const params = new URLSearchParams(location.search)
// Exercise the existing light theme without changing the host's appearance settings.
if (params.has('light')) {
  const disableDarkRules = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-color-scheme: dark')) rule.media.mediaText = 'not all'
      else if ('cssRules' in rule) disableDarkRules(rule.cssRules as CSSRuleList)
    }
  }
  for (const sheet of document.styleSheets) disableDarkRules(sheet.cssRules)
}
const large = params.has('large')
const revision = 'a'.repeat(64)
const timestamp = new Date().toISOString()
const sessions: PiSessionSummary[] = Array.from({ length: large ? 100 : 3 }, (_, index) => ({
  firstMessage: `会话 ${index} 的已有摘要`, id: `fixture-${index}`, cwd: '/fixture', name: index === 0 ? '接口排查' : `方案 ${index}`,
  parentSessionId: index ? `fixture-${large ? Math.min(index - 1, 20) : 0}` : undefined,
  ...(index ? { branch: { operationId: `op-${index}`, parentSessionId: `fixture-${large ? Math.min(index - 1, 20) : 0}`, sourceEntryId: 'u1', inheritedLeafId: 'a0', mode: 'edit' as const, state: 'ready' as const } } : {}),
}))
const selected = large ? 'fixture-20' : 'fixture-0'
const pages = Object.fromEntries(sessions.map((session, index) => [session.id, {
  revision, total: large ? 100 : 3, inheritedCount: index ? 1 : 0,
  entries: Array.from({ length: large ? 100 : 3 }, (_, turn) => ({ id: turn === 0 ? 'u0' : `u${index}-${turn}`, index: turn + 1,
    promptPreview: turn === 0 ? '共同问题：检查登录接口' : `分支 ${index} 的第 ${turn + 1} 轮`, startedAt: timestamp, endEntryId: turn === 0 ? 'a0' : `a${index}-${turn}`,
    continueEntryId: turn === 0 ? 'a0' : `a${index}-${turn}`,
    beforeCursor: turn < (large ? 99 : 2) ? `u${index}-${turn + 1}` : undefined })),
}]))
function history(id: string, before?: string) {
  let parentId: string | null = null
  const entries = pages[id].entries.flatMap((turn) => {
    const user = { id: turn.id, type: 'message', parentId, timestamp, raw: { type: 'message', message: { role: 'user', content: turn.promptPreview } } }
    const assistant = { id: turn.endEntryId, type: 'message', parentId: turn.id, timestamp, raw: { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `这是 ${id} 的完整回复。\n\n可在只读预览中阅读，发送目标保持原会话。` }], stopReason: 'stop' } } }
    parentId = assistant.id
    return [user, assistant]
  })
  const end = before ? entries.findIndex((entry) => entry.id === before) : entries.length
  const start = Math.max(0, end - 40)
  return { session: sessions.find((session) => session.id === id)!, entries: entries.slice(start, end), revision, hasEarlier: start > 0, beforeCursor: start > 0 ? entries[start].id : undefined }
}
let graphTurnReads = 0; let skeletonReads = 0; let mutations = 0
const historyReads: Record<string, number> = {}; const turnIndexReads: Record<string, number> = {}
const started = performance.now()
let firstCanvasMs: number | undefined
const metrics = document.createElement('output'); metrics.id = 'graph-metrics'; metrics.hidden = true; document.body.append(metrics)
const longTasks: number[] = []
const report = () => { metrics.textContent = JSON.stringify({ sessions: sessions.length, turns: sessions.length * (large ? 100 : 3), firstCanvasMs, graphTurnReads, skeletonReads, historyReads, turnIndexReads, mutations, elapsed: performance.now() - started, longTasks, heap: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize }) }
if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver((list) => { longTasks.push(...list.getEntries().map((entry) => entry.duration)); report() }).observe({ type: 'longtask' })
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (params.has('slow') && (url.pathname.endsWith('/graph') || url.pathname.endsWith('/history') || url.pathname.endsWith('/branch'))) await new Promise((resolve) => setTimeout(resolve, 300))
  const id = decodeURIComponent(url.pathname.split('/')[3] ?? selected)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (url.pathname.endsWith('/bootstrap')) return json({ token: 'fixture', runtimeId: 'fixture', websocketPath: '/fixture-ws' })
  if (url.pathname === '/api/projects') return json({ projects: [] })
  if (url.pathname === '/api/sessions') return json({ sessions, branchStorage: { available: true } })
  if (init?.method === 'PATCH' && url.pathname === `/api/sessions/${id}`) {
    const index = sessions.findIndex((session) => session.id === id)
    if (index < 0) return json({ error: 'Session not found' }, 404)
    const { name } = JSON.parse(init.body as string)
    sessions[index] = { ...sessions[index], name }; mutations++; report()
    return json({ session: { id, name } })
  }
  if (init?.method === 'DELETE' && url.pathname === `/api/sessions/${id}`) {
    const index = sessions.findIndex((session) => session.id === id)
    if (index < 0) return json({ error: 'Session not found' }, 404)
    sessions.splice(index, 1); mutations++; report()
    return new Response(null, { status: 204 })
  }
  if (url.pathname.endsWith('/graph')) { skeletonReads++; report(); return json({ sessions, branchStorage: { available: true } }) }
  if (url.pathname.endsWith('/graph-turns')) { graphTurnReads++; report(); return json({ error: '会话画布不得请求轮次图' }, 400) }
  if (url.pathname.endsWith('/turn-index')) { turnIndexReads[id] = (turnIndexReads[id] ?? 0) + 1; report(); return json({ revision, entries: pages[id].entries }) }
  if (url.pathname.endsWith('/history')) { historyReads[id] = (historyReads[id] ?? 0) + 1; report(); return json(history(id, url.searchParams.get('before') ?? undefined)) }
  if (url.pathname.endsWith('/branch')) {
    mutations++
    const request = JSON.parse(init?.body as string)
    const child = { id: `fixture-child-${mutations}`, cwd: '/fixture', name: `新建分支 ${mutations}`, parentSessionId: id,
      branch: { operationId: request.operationId, parentSessionId: id, sourceEntryId: request.entryId, inheritedLeafId: request.entryId, mode: request.mode ?? 'clone', state: 'ready' as const } }
    sessions.push(child); pages[child.id] = pages[id]; report()
    return json({ session: child, draft: request.mode === 'edit' ? '恢复的原输入' : '', operationId: request.operationId }, 201)
  }
  if (url.pathname === '/api/workspace-files/list') return json({ root: '/fixture', path: '', entries: [{ name: 'example.ts', path: 'example.ts', kind: 'file' }] })
  if (url.pathname === '/api/workspace-files/stat') return json({ path: 'example.ts', version: 'fixture-v1', fileBytes: 64 })
  if (url.pathname === '/api/workspace-files/text-page') return json({ kind: 'page', path: 'example.ts', version: 'fixture-v1', fileBytes: 64, cursor: { offset: 0, line: 1, midLine: false, version: 'fixture-v1' }, text: 'export const fixture = "文件预览仍可用"', startsMidLine: false, endsMidLine: false, endOffset: 64, lastLine: 1, eof: true })
  if (url.pathname === '/api/workspace-files/watch') return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/x-ndjson' } })
  if (url.pathname === '/api/configuration') return json({ settings: { effective: {} }, models: [], providers: [] })
  return json({ error: `Fixture route unavailable: ${url.pathname}` }, 404)
}
const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
client.setQueryData(['sessions'], sessions); client.setQueryData(['projects'], [])
  seedWorkspaceProjects(client)
useWorkspaceStore.setState({ workspaceView: 'tree', navigationView: 'tree', branchStorage: { available: true }, branchOperations: {}, drafts: { [selected]: '保留的当前分支草稿', 'fixture-1': '目标会话已有草稿' }, runs: {}, sessionNotifications: {}, navigationOrder: { projectOrder: [], sessionOrderByProject: {} }, filePreviews: {}, messageEdits: {}, legacyHiddenProjectCwds: {}, collapsedProjectKeys: {}, runtimeStates: {}, runtimeDetails: {}, watchStates: {} })
const runtime = runtimeFixture()
const controller = createSessionRunController({ runtime: runtime as never, invalidateHistory: async () => {} })
const paintObserver = new MutationObserver(() => {
  if (document.querySelector('[data-session-node]')) { firstCanvasMs = performance.now() - started; paintObserver.disconnect(); report() }
})
paintObserver.observe(document.getElementById('root')!, { childList: true, subtree: true })
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/?session=${selected}`]}><TooltipProvider><WorkspacePage sessionRuns={controller} /></TooltipProvider></MemoryRouter></QueryClientProvider>)
report()

if (new URLSearchParams(location.search).has('running')) {
  useWorkspaceStore.setState({ runs: { 'fixture-2': { status: 'running', turns: [], systemEvents: [] } } })
}
if (params.has('unread')) {
  const id = params.get('unread') === 'current' ? selected : 'fixture-1'
  useWorkspaceStore.setState({ sessionNotifications: { [id]: { completedRunId: 'fixture-completed' } } })
}
