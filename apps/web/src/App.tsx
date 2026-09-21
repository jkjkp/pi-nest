import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useRef } from 'react'
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Menu,
  PanelRight,
  RefreshCw,
  Send,
  Settings2,
  Square,
} from 'lucide-react'
import { Navigate, Route, Routes, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import { readSse } from './read-sse.js'
import {
  sessionHistoryQueryKey,
  type PiSessionHistoryMessage,
  type PiSessionHistoryResponse,
} from './history.js'
import { type PromptStatus, type SessionRunSummary, useWorkspaceStore } from './workspace-store.js'
import {
  formatUpdatedAt,
  type PiSessionSummary,
  projectName,
  sessionStatusLabel,
  shortSessionId,
} from './workspace.js'

type HealthResponse = { status?: string }
const emptySessions: PiSessionSummary[] = []

async function fetchJson<T>(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
  return (await response.json()) as T
}

function App() {
  return (
    <TooltipProvider>
      <Routes>
        <Route path="/" element={<Workspace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TooltipProvider>
  )
}

function Workspace() {
  const requestController = useRef<AbortController | undefined>(undefined)
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedSessionId = searchParams.get('session') ?? ''
  const drafts = useWorkspaceStore((state) => state.drafts)
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen)
  const inspectorWidth = useWorkspaceStore((state) => state.inspectorWidth)
  const navigationOpen = useWorkspaceStore((state) => state.navigationOpen)
  const navigationWidth = useWorkspaceStore((state) => state.navigationWidth)
  const runs = useWorkspaceStore((state) => state.runs)
  const setDraft = useWorkspaceStore((state) => state.setDraft)
  const setInspectorOpen = useWorkspaceStore((state) => state.setInspectorOpen)
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  const setRun = useWorkspaceStore((state) => state.setRun)
  const updateRun = useWorkspaceStore((state) => state.updateRun)
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => fetchJson<HealthResponse>('/api/health'),
    refetchInterval: 10_000,
    retry: 1,
    staleTime: 5_000,
  })
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      const body = await fetchJson<{ sessions?: PiSessionSummary[] }>('/api/sessions')
      if (!Array.isArray(body.sessions)) throw new Error('Invalid session list response')
      return body.sessions
    },
  })
  const sessions = sessionsQuery.data ?? emptySessions
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
  const historyQuery = useQuery({
    enabled: Boolean(selectedSession),
    queryKey: sessionHistoryQueryKey(selectedSessionId),
    queryFn: () => fetchJson<PiSessionHistoryResponse>(`/api/sessions/${encodeURIComponent(selectedSessionId)}/history`),
    retry: false,
  })
  const currentRun = selectedSessionId ? runs[selectedSessionId] : undefined
  const status = currentRun?.status ?? 'idle'
  const isActive = status === 'running' || status === 'aborting'
  const isAnySessionActive = Object.values(runs).some(
    (run) => run.status === 'running' || run.status === 'aborting',
  )
  const prompt = drafts[selectedSessionId] ?? ''

  useEffect(() => {
    if (sessions.length === 0 || sessions.some((session) => session.id === selectedSessionId)) return

    setSearchParams({ session: sessions[0].id }, { replace: true })
  }, [selectedSessionId, sessions, setSearchParams])

  useEffect(() => () => requestController.current?.abort(), [])

  function selectSession(sessionId: string) {
    if (isAnySessionActive) return
    setSearchParams({ session: sessionId })
    setNavigationOpen(false)
  }

  async function refreshWorkspace() {
    await Promise.all([health.refetch(), sessionsQuery.refetch()])
  }

  async function submitPrompt(event: FormEvent) {
    event.preventDefault()
    if (!selectedSessionId || isActive || prompt.trim().length === 0) return

    const controller = new AbortController()
    requestController.current = controller
    setRun(selectedSessionId, { responseText: '', status: 'running' })
    let terminalEvent = false

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/prompts`, {
        body: JSON.stringify({ prompt }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      })

      await readSse(response, ({ data, event: eventName }) => {
        const payload = JSON.parse(data) as {
          delta?: string
          message?: string
          model?: { provider: string; id: string }
          stopReason?: string
        }

        if (eventName === 'text_delta' && typeof payload.delta === 'string') {
          updateRun(selectedSessionId, {
            responseText: (useWorkspaceStore.getState().runs[selectedSessionId]?.responseText ?? '') + payload.delta,
          })
        }
        if (eventName === 'complete') {
          terminalEvent = true
          updateRun(selectedSessionId, {
            model: payload.model && `${payload.model.provider}/${payload.model.id}`,
            status: payload.stopReason === 'aborted' ? 'aborted' : 'complete',
          })
        }
        if (eventName === 'error') {
          terminalEvent = true
          throw new Error(payload.message ?? 'Pi session prompt failed')
        }
      })

      if (!terminalEvent) throw new Error('Pi session stream ended without a result')
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        updateRun(selectedSessionId, {
          error: cause instanceof Error ? cause.message : 'Pi session prompt failed',
          status: 'error',
        })
      }
    } finally {
      if (requestController.current === controller) requestController.current = undefined
      void queryClient.invalidateQueries({ queryKey: sessionHistoryQueryKey(selectedSessionId) })
    }
  }

  async function abortPrompt() {
    if (!selectedSessionId || status !== 'running') return

    updateRun(selectedSessionId, { error: undefined, status: 'aborting' })
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/abort`, {
        method: 'POST',
      })
      if (response.status !== 202) throw new Error('Pi session could not be stopped')
    } catch (cause) {
      updateRun(selectedSessionId, {
        error: cause instanceof Error ? cause.message : 'Pi session could not be stopped',
        status: 'running',
      })
    }
  }

  const navigation = (
    <SessionNavigation
      disabled={isAnySessionActive}
      error={sessionsQuery.error}
      isLoading={sessionsQuery.isPending}
      onSelect={selectSession}
      runs={runs}
      selectedSessionId={selectedSessionId}
      sessions={sessions}
    />
  )
  const inspector = <SessionInspector run={currentRun} session={selectedSession} />

  return (
    <main className="grid min-h-svh grid-rows-[auto_minmax(0,1fr)] bg-background text-foreground">
      <header className="flex min-h-14 items-center gap-3 border-b bg-card px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
            <SheetTrigger asChild>
              <Button aria-label="打开会话导航" className="md:hidden" size="icon-sm" variant="ghost">
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent className="p-0" side="left">
              <SheetTitle className="sr-only">会话导航</SheetTitle>
              <SheetDescription className="sr-only">选择要查看的 Pi 原生会话。</SheetDescription>
              {navigation}
            </SheetContent>
          </Sheet>
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            PN
          </span>
          <span className="truncate text-sm font-semibold tracking-tight">Pi Nest</span>
        </div>

        <div aria-live="polite" className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <ConnectionStatus health={health} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="刷新会话列表"
                disabled={sessionsQuery.isFetching}
                onClick={() => void refreshWorkspace()}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshCw aria-hidden="true" className={sessionsQuery.isFetching ? 'animate-spin' : ''} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>刷新会话列表</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button aria-label="设置暂不可用" disabled size="icon-sm" variant="ghost">
                  <Settings2 aria-hidden="true" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>设置将在后续版本提供</TooltipContent>
          </Tooltip>
          <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
            <SheetTrigger asChild>
              <Button aria-label="打开会话检查器" className="xl:hidden" size="icon-sm" variant="ghost">
                <PanelRight aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent className="p-0" side="right">
              <SheetTitle className="sr-only">会话检查器</SheetTitle>
              <SheetDescription className="sr-only">当前会话的运行摘要与元信息。</SheetDescription>
              {inspector}
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <div
        className="workspace-grid grid min-h-0"
        style={
          {
            '--inspector-width': `${inspectorWidth}px`,
            '--navigation-width': `${navigationWidth}px`,
          } as CSSProperties
        }
      >
        <aside className="hidden min-h-0 border-r bg-card/60 md:block">{navigation}</aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="border-b px-4 py-4 sm:px-6">
            <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">当前会话</p>
            {selectedSession ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="font-mono text-base font-semibold">{shortSessionId(selectedSession.id)}</h1>
                <StatusBadge status={status} />
                <span className="font-mono text-xs text-muted-foreground">{selectedSession.cwd ?? 'cwd 不可用'}</span>
              </div>
            ) : (
              <h1 className="mt-2 text-lg font-semibold">选择一个会话</h1>
            )}
          </header>

          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
              <SessionTimeline
                error={historyQuery.isError}
                history={historyQuery.data}
                isLoading={historyQuery.isPending}
                onRetry={() => void historyQuery.refetch()}
              />
              <section className="border-b pb-6">
                {isActive && currentRun?.responseText && (
                  <pre aria-live="polite" className="mt-4 whitespace-pre-wrap break-words text-sm leading-6">
                    {currentRun.responseText}
                  </pre>
                )}
                {currentRun?.error && (
                  <p className="mt-4 flex items-center gap-2 text-sm text-destructive" role="alert">
                    <CircleX aria-hidden="true" className="size-4" />
                    {currentRun.error}
                  </p>
                )}
              </section>

              <form className="grid gap-3" onSubmit={(event) => void submitPrompt(event)}>
                <label className="text-sm font-semibold" htmlFor="prompt">
                  输入提示词
                </label>
                <Textarea
                  disabled={!selectedSession || isActive}
                  id="prompt"
                  maxLength={20_000}
                  onChange={(event) => selectedSessionId && setDraft(selectedSessionId, event.target.value)}
                  placeholder="向当前原生 Pi 会话发送提示词"
                  rows={5}
                  value={prompt}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={!selectedSession || prompt.trim().length === 0 || isActive} type="submit">
                    <Send aria-hidden="true" data-icon="inline-start" />
                    发送
                  </Button>
                  {status === 'running' && (
                    <Button onClick={() => void abortPrompt()} type="button" variant="destructive">
                      <Square aria-hidden="true" data-icon="inline-start" />
                      停止生成
                    </Button>
                  )}
                  {status === 'aborting' && <span className="text-sm text-muted-foreground">正在停止…</span>}
                </div>
              </form>
            </div>
          </ScrollArea>
        </section>

        <aside className="hidden min-h-0 border-l bg-card/60 xl:block">{inspector}</aside>
      </div>
    </main>
  )
}

function SessionTimeline({
  error,
  history,
  isLoading,
  onRetry,
}: {
  error: boolean
  history: PiSessionHistoryResponse | undefined
  isLoading: boolean
  onRetry: () => void
}) {
  if (isLoading) {
    return (
      <section aria-label="正在加载会话历史" className="space-y-3">
        {Array.from({ length: 3 }, (_, index) => <Skeleton className="h-24" key={index} />)}
      </section>
    )
  }

  if (error) {
    return (
      <section className="border-b pb-6" role="alert">
        <h2 className="text-sm font-semibold">无法读取会话历史</h2>
        <p className="mt-2 text-sm text-muted-foreground">历史仍保留在本机原生会话中；请刷新后重试。</p>
        <Button className="mt-3" onClick={onRetry} size="sm" type="button" variant="secondary">
          重试
        </Button>
      </section>
    )
  }

  if (!history) return null

  if (history.entries.length === 0) {
    return (
      <section className="border-b pb-6">
        <h2 className="text-sm font-semibold">会话内容</h2>
        <p className="mt-2 text-sm text-muted-foreground">当前活动分支尚无可展示的消息。</p>
      </section>
    )
  }

  return (
    <section className="space-y-3 border-b pb-6">
      <h2 className="text-sm font-semibold">会话内容</h2>
      {history.hasEarlier && (
        <p className="text-xs text-muted-foreground">首版仅展示当前活动分支最近 200 条原生记录。</p>
      )}
      {history.entries.map((entry, index) =>
        entry.kind === 'omitted' ? (
          <div className="border-l-2 border-muted px-3 py-2 text-xs text-muted-foreground" key={`${entry.timestamp}-${index}`}>
            {entry.label}（连续 {entry.count} 条）
          </div>
        ) : (
          <TimelineMessage entry={entry} key={entry.id} />
        ),
      )}
    </section>
  )
}

function TimelineMessage({ entry }: { entry: PiSessionHistoryMessage }) {
  const assistant = entry.role === 'assistant'
  return (
    <article className={assistant ? 'border bg-card p-4' : 'border bg-muted/45 p-3'}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{assistant ? '助手' : '用户'}</span>
        <time dateTime={entry.timestamp}>{formatUpdatedAt(entry.timestamp)}</time>
      </header>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{entry.text}</p>
      {(entry.stopReason || entry.hasOmittedContent) && (
        <footer className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {entry.stopReason && <span>终止原因：{entry.stopReason}</span>}
          {entry.hasOmittedContent && <span>包含未展示的原生内容</span>}
        </footer>
      )}
    </article>
  )
}

function ConnectionStatus({ health }: { health: UseQueryResult<HealthResponse, Error> }) {
  const state = health.isError ? '不可用' : health.isFetching ? '重连中' : '已连接'
  const Icon = health.isError ? CircleX : health.isFetching ? RefreshCw : CircleCheck
  const color = health.isError ? 'text-destructive' : health.isFetching ? 'text-warning' : 'text-success'

  return (
    <span className={`hidden items-center gap-1.5 sm:inline-flex ${color}`}>
      <Icon aria-hidden="true" className={health.isFetching ? 'size-3 animate-spin' : 'size-3'} />
      {state}
    </span>
  )
}

function SessionNavigation({
  disabled,
  error,
  isLoading,
  onSelect,
  runs,
  selectedSessionId,
  sessions,
}: {
  disabled: boolean
  error: Error | null
  isLoading: boolean
  onSelect: (sessionId: string) => void
  runs: Record<string, SessionRunSummary>
  selectedSessionId: string
  sessions: PiSessionSummary[]
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-4">
        <h2 className="text-sm font-semibold">会话</h2>
        <p className="mt-1 text-xs text-muted-foreground">本机原生 Pi 会话</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {isLoading && Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-16" />)}
          {error && <p className="p-3 text-sm text-destructive">会话列表不可用</p>}
          {!isLoading && !error && sessions.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">未发现本机 Pi 会话</p>
          )}
          {sessions.map((session) => {
            const status = runs[session.id]?.status ?? 'idle'
            const selected = session.id === selectedSessionId
            return (
              <Button
                aria-current={selected ? 'page' : undefined}
                className="h-auto w-full justify-start px-3 py-2 text-left"
                disabled={disabled}
                key={session.id}
                onClick={() => onSelect(session.id)}
                variant={selected ? 'secondary' : 'ghost'}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{projectName(session.cwd)}</span>
                    <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  </span>
                  <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                    {shortSessionId(session.id)} · {formatUpdatedAt(session.updatedAt)}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{sessionStatusLabel(status)}</span>
                </span>
              </Button>
            )
          })}
        </div>
      </ScrollArea>
      {disabled && <p className="border-t px-4 py-3 text-xs text-muted-foreground">生成期间暂不能切换会话</p>}
    </div>
  )
}

function SessionInspector({ run, session }: { run: SessionRunSummary | undefined; session: PiSessionSummary | undefined }) {
  const status = run?.status ?? 'idle'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-4">
        <h2 className="text-sm font-semibold">会话检查器</h2>
        <p className="mt-1 text-xs text-muted-foreground">运行摘要与安全元信息</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <dl className="space-y-5 p-4 text-sm">
          <InspectorItem label="运行状态">
            <StatusBadge status={status} />
          </InspectorItem>
          <InspectorItem label="Session ID">
            <span className="break-all font-mono text-xs">{session?.id ?? '未选择'}</span>
          </InspectorItem>
          <InspectorItem label="项目目录">
            <span className="break-all font-mono text-xs">{session?.cwd ?? '不可用'}</span>
          </InspectorItem>
          <InspectorItem label="最近更新">{formatUpdatedAt(session?.updatedAt)}</InspectorItem>
          <InspectorItem label="模型">{run?.model ?? '尚未读取'}</InspectorItem>
          <InspectorItem label="Thinking">尚未读取</InspectorItem>
          <InspectorItem label="工具">已禁用（受限模式）</InspectorItem>
          <InspectorItem label="原生文件">受保护，不向浏览器暴露</InspectorItem>
          {run?.error && (
            <InspectorItem label="最近错误">
              <span className="flex gap-2 text-destructive">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {run.error}
              </span>
            </InspectorItem>
          )}
        </dl>
      </ScrollArea>
    </div>
  )
}

function InspectorItem({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  )
}

function StatusBadge({ status }: { status: PromptStatus }) {
  const color =
    status === 'running' || status === 'aborting'
      ? 'text-warning'
      : status === 'complete'
        ? 'text-success'
        : status === 'error'
          ? 'text-destructive'
          : 'text-muted-foreground'

  return <span className={`text-xs font-medium ${color}`}>{sessionStatusLabel(status)}</span>
}

export default App
