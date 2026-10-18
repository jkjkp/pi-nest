import { FilePreviewResizeHandle } from './file-preview-resize-handle.js'
import { OpenToolFile } from './tool-file-context.js'
import { SessionFilePreview } from './session-file-preview.js'
import { ProjectDialog } from './project-dialog.js'
import { ProjectHome } from './project-home.js'
import { SessionForkDialog } from './session-fork-dialog.js'
import { CommandNotice } from './command-notice.js'
import { RenderErrorBoundary } from './render-error-boundary.js'
import { parseComposerCommand } from './composer-commands.js'
import { useWorkspaceCommands } from './use-workspace-commands.js'
import { SessionRenameDialog } from './session-rename-dialog.js'
import { SessionStatistics } from './session-statistics.js'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, CircleX, Folder, LoaderCircle, Menu, PanelRight, Send, Settings, Square } from 'lucide-react'
import { Link, useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { CommandComposer } from './command-composer.js'

import { resizeComposerTextarea, useComposerTextarea } from './composer-textarea.js'
import { useComposerHistory } from './composer-history.js'
import { timelineItems } from './timeline-model.js'
import { ThinkingSelector } from './thinking-selector.js'
import { ModelSelector } from './model-selector.js'
import { SessionInspector } from './session-inspector.js'
import { SessionNavigation } from './session-navigation.js'
import type { SessionRunController } from './session-run-controller.js'
import { SessionTimeline } from './session-timeline.js'
import { ExtensionUiInline } from './runtime-extension-ui.js'
import { useWorkspaceStore } from './workspace-store.js'
import { useWorkspaceSession } from './use-workspace-session.js'
import { useTimelineViewport } from './use-timeline-viewport.js'
import { sessionDisplayName, sessionStatusLabel } from './workspace.js'
import type { PendingInput } from './session-run-model.js'

export function WorkspacePage({ sessionRuns }: { sessionRuns: SessionRunController }) {
  const session = useWorkspaceSession(sessionRuns)
  const navigate = useNavigate()
  const {
    selectedSessionId, selectedSession, sessionResolution, draftProject, isDraft, prompt, currentRun, activeTurn, currentModel, modelLabel, modelStatus, modelError, status, isActive, isStreaming,
    extensionStatus, extensionWidget, planStatus, planPolicy, runtimeStatus, runtimeStates, runs, projects, collapsedProjectKeys,
    navigationOrder, setNavigationOrder, setProjectCollapsed, setDraft, setDraftPrompt,
    mutatingSessionId, creatingDraft, draftError, controlError, models, thinkingLevels, thinkingOpen, setThinkingOpen, thinkingStatus, thinkingError, thinkingFailure, currentThinkingLevel,
    sessionsQuery, projectsQuery, historyQuery, history, historyError, planTurnId, turnIndexQuery, navigationNotice, retryNavigation, pendingJump, setPendingJump,
    startDraft, openProject, removeProject, steerQueued, retrySteering, submittingInput, abortPrompt, openModels, openThinking, handleRename, handleDelete,
    readTurnPrompt, jumpToUnloadedTurn, revealProjectInFinder, changeModel, changeThinkingLevel, loadEarlier, retryHistory,
  } = session
  const isHome = !selectedSessionId && !isDraft
  const displaySession = selectedSession ?? history?.session
  const sessionTitle = displaySession ? sessionDisplayName(displaySession) : selectedSessionId ? sessionResolution === 'missing' ? '会话暂不可用' : '正在恢复会话…' : draftProject ? `新对话 · ${draftProject.name}` : '项目'
  const runtimeStatistics = useWorkspaceStore((state) => state.runtimeStatistics[selectedSessionId])
  const runtimeLoading = runtimeStates[selectedSessionId]?.lifecycle === 'loading'
  const watchReady = useWorkspaceStore((state) => state.watchStates[selectedSessionId] === 'ready')
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen)
  const inspectorWidth = useWorkspaceStore((state) => state.inspectorWidth)
  const setInspectorWidth = useWorkspaceStore((state) => state.setInspectorWidth)
  const workspaceGrid = useRef<HTMLDivElement>(null)
  const navigationOpen = useWorkspaceStore((state) => state.navigationOpen)
  const navigationWidth = useWorkspaceStore((state) => state.navigationWidth)
  const setInspectorOpen = useWorkspaceStore((state) => state.setInspectorOpen)
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  const [creatingProject, setCreatingProject] = useState(false)
  const [modelSelector, setModelSelector] = useState<{ sessionId?: string; open: boolean }>({ open: false })
  const modelSelectorOpen = modelSelector.sessionId === selectedSessionId && modelSelector.open
  const setModelSelectorOpen = (open: boolean) => setModelSelector({ sessionId: selectedSessionId, open })
  const [fileSheetOpen, setFileSheetOpen] = useState(false)
  const {
    setComposer, showScrollToBottom, scrollToBottom, setFollowingLatest, railOverlay, scrollViewport, setMessageScrollArea, setRailOverlayRoot,
    scrollToFinalAnswer, followFinalAnswer, jumpToTurn, toggleInspector,
    rememberReadingPosition, registerTimelineScroll,
  } = useTimelineViewport({ selectedSessionId, history, activeTurn, latestSteeringId: currentRun?.turns.findLast((turn) => turn.steering)?.id, isActive, inspectorOpen, setInspectorOpen })
  const promptTextareaRef = useComposerTextarea(prompt)
  const promptHistory = useComposerHistory(
    selectedSessionId || (isDraft ? `draft:${draftProject?.key}` : ''),
    isDraft ? [] : timelineItems(history?.entries, currentRun?.turns ?? [], currentRun?.systemEvents ?? []),
    prompt,
    (value) => isDraft ? setDraftPrompt(value) : selectedSessionId && setDraft(selectedSessionId, value),
    promptTextareaRef,
  )

  const [commandPanels, setCommandPanels] = useState<{ sessionId: string; statistics: boolean; fork?: (entryId: string, revision: string) => Promise<void>; rename?: { session: NonNullable<typeof selectedSession>; onSaved: () => void } }>({ sessionId: selectedSessionId, statistics: false })
  if (commandPanels.sessionId !== selectedSessionId) setCommandPanels({ sessionId: selectedSessionId, statistics: false })
  const commands = useWorkspaceCommands(session, sessionRuns, {
    fork: (onFork) => setCommandPanels({ sessionId: selectedSessionId, statistics: false, fork: onFork }),
    model: () => { setModelSelectorOpen(true); void openModels() },
    rename: (onSaved) => { if (selectedSession) setCommandPanels({ sessionId: selectedSessionId, statistics: false, rename: { session: selectedSession, onSaved } }) },
    statistics: () => setCommandPanels({ sessionId: selectedSessionId, statistics: true }),
    settings: () => { void navigate(`/settings?session=${encodeURIComponent(selectedSessionId)}`) },
  })

  function selectSession(sessionId: string) {
    rememberReadingPosition()
    session.selectSession(sessionId)
  }

  function submitPrompt(mode: 'follow_up' | 'steer' = 'follow_up') {
    if ((!selectedSessionId && !isDraft) || !prompt.trim()) return
    if (commands.submit(prompt)) return
    if (mode !== 'steer') setFollowingLatest(true)
    session.submitPrompt(mode)
  }

  useEffect(() => {
    const media = window.matchMedia('(min-width: 80rem)')
    const closeSheetOnDesktop = () => {
      if (!media.matches) return
      setFileSheetOpen(false)
    }
    closeSheetOnDesktop()
    media.addEventListener('change', closeSheetOnDesktop)
    return () => media.removeEventListener('change', closeSheetOnDesktop)
  }, [])

  const navigation = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <SessionNavigation
          collapsedProjectKeys={collapsedProjectKeys}
          error={sessionsQuery.error}
          isLoading={sessionsQuery.isPending}
          mutationSessionId={mutatingSessionId}
          onDelete={handleDelete}
          onAddProject={() => setCreatingProject(true)}
          onNewConversation={startDraft}
          onProjectOrderChange={(projectOrder) => setNavigationOrder({ ...navigationOrder, projectOrder })}
          onRemoveProject={removeProject}
          onRename={handleRename}
          onRevealProject={revealProjectInFinder}
          onSelect={selectSession}
          onSessionOrderChange={(projectKey, sessionOrder) =>
            setNavigationOrder({
              ...navigationOrder,
              sessionOrderByProject: { ...navigationOrder.sessionOrderByProject, [projectKey]: sessionOrder },
            })
          }
          onToggleProject={setProjectCollapsed}
          projects={projects}
          runs={runs}
          selectedSessionId={selectedSessionId}
        />
      </div>
      <footer className="shrink-0 space-y-1 border-t p-3">
        <Button asChild className="w-full justify-start" size="sm" variant="ghost"><Link to={selectedSession ? `/settings?session=${encodeURIComponent(selectedSession.id)}` : '/settings'} onClick={() => setNavigationOpen(false)}><Settings aria-hidden="true" />设置</Link></Button>
      </footer>
    </div>
  )
  const [preview, setPreview] = useState<{ sessionId: string; path: string; line?: number; searchRoot?: string }>()
  const currentPreview = preview?.sessionId === selectedSessionId ? preview : undefined
  const openToolFile = useCallback((path: string, line?: number, searchRoot?: string) => {
    setPreview({ sessionId: selectedSessionId, path, line, searchRoot })
    if (window.matchMedia('(min-width: 80rem)').matches) setInspectorOpen(true)
    else setFileSheetOpen(true)
  }, [selectedSessionId, setInspectorOpen])
  const filePreview = currentPreview ? <SessionFilePreview key={`${selectedSessionId}:${currentPreview.searchRoot}:${currentPreview.path}:${currentPreview.line}`} sessionId={selectedSessionId} path={currentPreview.path} searchRoot={currentPreview.searchRoot} line={currentPreview.line} onClose={() => { setPreview(undefined); setFileSheetOpen(false); setInspectorOpen(false) }} /> : null

  return (
    <OpenToolFile value={openToolFile}><main className="relative flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      {creatingProject && <ProjectDialog mode="register" onClose={() => setCreatingProject(false)} onAdded={openProject} />}
      {commandPanels.sessionId === selectedSessionId && commandPanels.fork && <SessionForkDialog key={`fork:${selectedSessionId}`} sessionId={selectedSessionId} onClose={() => setCommandPanels({ sessionId: selectedSessionId, statistics: false })} onCloseAutoFocus={(event) => { event.preventDefault(); requestAnimationFrame(() => promptTextareaRef.current?.focus()) }} onFork={commandPanels.fork} />}
      {commandPanels.sessionId === selectedSessionId && commandPanels.rename && <SessionRenameDialog key={selectedSessionId} session={commandPanels.rename.session} onCloseAutoFocus={(event) => { event.preventDefault(); promptTextareaRef.current?.focus() }} onClose={() => setCommandPanels({ sessionId: selectedSessionId, statistics: false })} onRename={async (id, name) => {
        if (isActive || ['loading', 'switching'].includes(modelStatus) || ['loading', 'switching'].includes(thinkingStatus)) throw new Error('请等待当前会话操作结束。')
        await handleRename(id, name)
        commandPanels.rename?.onSaved()
      }} />}
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-card px-3 sm:px-4 md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
            <SheetTrigger asChild>
              <Button aria-label="打开会话导航" className="md:hidden" size="icon-sm" variant="ghost"><Menu aria-hidden="true" /></Button>
            </SheetTrigger>
            <SheetContent className="p-0" side="left">
              <SheetTitle className="sr-only">会话导航</SheetTitle>
              <SheetDescription className="sr-only">选择要查看的 Pi 原生会话。</SheetDescription>
              {navigation}
            </SheetContent>
          </Sheet>
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">PN</span>
          <h1 className="truncate text-sm font-semibold tracking-tight" title={displaySession ? sessionDisplayName(displaySession) : undefined}>{sessionTitle}</h1>
        </div>
      </header>
      <Sheet open={fileSheetOpen && Boolean(currentPreview)} onOpenChange={setFileSheetOpen}>
        <SheetContent className="p-0" side="right">
          <SheetTitle className="sr-only">文件预览</SheetTitle>
          <SheetDescription className="sr-only">查看当前项目内的文件内容。</SheetDescription>
          {filePreview}
        </SheetContent>
      </Sheet>

      <div
        className="workspace-grid grid min-h-0 flex-1"
        ref={workspaceGrid}
        style={{ '--inspector-width': `${inspectorWidth}px`, '--navigation-width': `${navigationWidth}px`, '--side-panel-width': !isHome && currentPreview && inspectorOpen ? `${Number.isFinite(inspectorWidth) ? inspectorWidth : 300}px` : '0px' } as CSSProperties}
      >
        <aside className="hidden min-h-0 border-r bg-card/60 md:block">{navigation}</aside>
        <section className="relative flex min-h-0 min-w-0 flex-col [--composer-height:132px]">
          <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-background/95 py-2 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:pl-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {(selectedSession || draftProject) && <Folder aria-hidden="true" className="size-[18px] shrink-0 text-muted-foreground" />}
              <h1 className="min-w-0 truncate text-base font-semibold" title={displaySession ? sessionDisplayName(displaySession) : undefined}>{sessionTitle}</h1>
              {selectedSession && <span className="inline-flex size-4 shrink-0" role={runtimeLoading ? 'status' : undefined} aria-label={runtimeLoading ? '正在加载 Pi 运行时' : undefined}>{runtimeLoading && <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />}</span>}
            </div>
            {currentPreview && <Button aria-label={inspectorOpen ? '收起文件预览' : '打开文件预览'} onClick={() => {
              if (window.matchMedia('(min-width: 80rem)').matches) toggleInspector()
              else setFileSheetOpen(true)
            }} size="icon-sm" type="button" variant="ghost"><PanelRight aria-hidden="true" /></Button>}
            {selectedSessionId && <SessionInspector key={selectedSessionId} run={currentRun} session={displaySession} />}
          </header>
          <div className="relative min-h-0 flex-1" ref={setMessageScrollArea}>
            <ScrollArea className="timeline-scroll h-full">
              <div className={isHome ? "w-full" : "w-full space-y-4 px-4 pt-6 pb-[calc(var(--composer-height)+3rem)] sm:px-6"}>
                {(sessionResolution === 'error' || sessionResolution === 'missing') && <div className="conversation-stage"><div className="conversation-stage-content flex items-center gap-2 text-sm text-muted-foreground" role="status"><span>{sessionResolution === 'error' ? '会话列表读取失败，已保留当前会话。' : '当前会话未出现在列表中，已保留现有内容。'}</span><Button type="button" size="sm" variant="ghost" onClick={() => void sessionsQuery.refetch()}>重试会话列表</Button></div></div>}
                {isDraft ? (
                  <div className="conversation-stage py-16">
                    <section className="conversation-stage-content grid min-h-56 place-items-center rounded-2xl border border-dashed bg-muted/20 p-8 text-center">
                      <div className="space-y-2"><h2 className="text-lg font-semibold">在 {draftProject?.name} 开始新对话</h2><p className="text-sm text-muted-foreground">发送第一条消息后才会创建 Pi 会话。</p></div>
                    </section>
                  </div>
                ) : selectedSessionId ? <RenderErrorBoundary key={selectedSessionId} scope="timeline" sessionId={selectedSessionId}><SessionTimeline
                  onSelectModel={() => { setModelSelectorOpen(true); void openModels() }}
                  sessionCwd={displaySession?.cwd}
                  error={historyError}
                  hasEarlier={historyQuery.hasPreviousPage}
                  history={history}
                  isLoading={!history && historyQuery.isPending}
                  isLoadingEarlier={historyQuery.isFetchingPreviousPage}
                  isRunning={isStreaming}
                  onLoadEarlier={loadEarlier}
                  onFinalAnswerStart={scrollToFinalAnswer}
                  onFinalAnswerStream={followFinalAnswer}
                  onRetrySteering={retrySteering}
                  onJumpToTurn={jumpToTurn}
                  onReadTurnPrompt={readTurnPrompt}
                  onJumpToUnloadedTurn={jumpToUnloadedTurn}
                  onRetry={retryHistory}
                  onPendingJumpHandled={() => setPendingJump(undefined)}
                  overlayRoot={railOverlay}
                  pendingInputs={currentRun?.pendingInputs}
                  pendingJumpTurnId={pendingJump?.sessionId === selectedSessionId ? pendingJump.turnId : undefined}
                  scrollViewport={scrollViewport}
                  registerTimelineScroll={registerTimelineScroll}
                  systemEvents={currentRun?.systemEvents}
                  runStatus={status}
                  runMessage={currentRun?.waitingMessage}
                  turnIndex={turnIndexQuery.data}
                  navigationNotice={navigationNotice}
                  onRetryNavigation={retryNavigation}
                  turns={currentRun?.turns}
                /></RenderErrorBoundary> : <ProjectHome projects={projects} loading={sessionsQuery.isPending || projectsQuery.isPending} error={sessionsQuery.isError || projectsQuery.isError} onRetry={() => { void sessionsQuery.refetch(); void projectsQuery.refetch() }} onProjectAdded={openProject} onOpen={startDraft} />}
                <div className="conversation-stage">
                  <section className="conversation-stage-content space-y-3">
                    {!isDraft && extensionWidget ? <pre className="rounded border bg-muted p-2 text-xs">{extensionWidget}</pre> : null}
                    {isActive && !activeTurn?.prompt && (
                      <div aria-live="polite">
                        <p className="text-xs font-medium text-warning">{sessionStatusLabel(status)}</p>
                      </div>
                    )}
                    {currentRun?.error && (
                      <p className="flex items-center gap-2 rounded-lg border border-destructive/30 border-l-2 border-l-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                        <CircleX aria-hidden="true" className="size-4" />
                        {currentRun.error}
                      </p>
                    )}
                    {!currentRun?.error && runtimeStatus && <p className="text-xs text-muted-foreground" role={runtimeStates[selectedSessionId]?.lifecycle === 'failed' ? 'alert' : undefined}>{runtimeStatus}</p>}
                    {controlError && <p className="text-xs text-destructive" role="alert">{controlError}</p>}
                    {draftError && <p className="text-xs text-destructive" role="alert">{draftError}</p>}
                  </section>
                </div>
              </div>
            </ScrollArea>
            <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden px-4 sm:px-6">
              <div className="relative h-full w-full" ref={setRailOverlayRoot} />
              {selectedSession && !isDraft && showScrollToBottom && <div className="conversation-stage absolute inset-x-0 bottom-[calc(var(--composer-height)+0.75rem)] px-4 sm:px-6"><div className="conversation-stage-content flex justify-center"><Button aria-label="滚动到对话底部" className="pointer-events-auto size-11 rounded-full border bg-background/95 shadow-md sm:size-9" onClick={scrollToBottom} onPointerDown={(event) => event.preventDefault()} size="icon" variant="outline"><ArrowDown aria-hidden="true" className="size-5" /></Button></div></div>}
            </div>
          </div>
          {!isHome && <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-transparent px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6" ref={setComposer} data-slot="composer">
            <div className="conversation-stage">
              <div className="conversation-stage-content">
                <div className="pointer-events-auto"><ExtensionUiInline sessionId={selectedSessionId} planTurnId={planTurnId} onViewPlan={() => { if (planTurnId) setPendingJump({ sessionId: selectedSessionId, turnId: planTurnId }) }} onRetryPlan={retryHistory} /></div>
                <PendingInputs inputs={(currentRun?.pendingInputs ?? []).filter((input) => !currentRun?.turns.some((turn) => turn.steering?.queuedInputId === input.id && turn.steering.status !== 'failed'))} key={selectedSessionId} onSteer={steerQueued} disabled={submittingInput || status !== 'running'} />
                <CommandNotice notice={commands.notice} />
                <div data-slot="message-composer" className="pointer-events-auto flex min-h-[100px] w-full flex-col justify-between gap-1 rounded-[2.5rem] border bg-muted px-5 py-3 shadow-sm dark:border-white/10 dark:bg-[#303030] sm:px-6">
              <label className="sr-only" htmlFor="prompt">{isDraft ? '输入新对话的第一条提示词' : '向当前 Pi 会话发送提示词'}</label>
              <CommandComposer
                onExecuteCommand={(value) => { commands.submit(value) }}
                key={selectedSessionId || `draft:${draftProject?.key}`}
                sessionId={isDraft ? '' : selectedSessionId}
                sessionRuns={sessionRuns}
                canQuery={!commands.busy && watchReady && !isActive && runtimeStates[selectedSessionId]?.lifecycle === 'idle' && modelStatus !== 'loading' && modelStatus !== 'switching' && thinkingStatus !== 'loading' && thinkingStatus !== 'switching'}
                className="min-h-0! shrink-0 resize-none border-0 bg-transparent px-0 py-0 text-[16px] leading-7 shadow-none placeholder:text-muted-foreground/70 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
                disabled={(!selectedSession && !isDraft) || creatingDraft}
                id="prompt"
                maxLength={20_000}
                onFocus={(event) => resizeComposerTextarea(event.currentTarget)}
                onValueChange={(value) => {
                  promptHistory.reset()
                  if (isDraft) setDraftPrompt(value)
                  else if (selectedSessionId) setDraft(selectedSessionId, value)
                }}
                onKeyDown={(event) => {
                  if (promptHistory.onKeyDown(event)) return
                  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return

                  event.preventDefault()
                  submitPrompt(event.ctrlKey ? 'steer' : 'follow_up')
                }}
                placeholder={isDraft ? '随心输入…' : status === 'running' ? 'Enter 排队，Ctrl + Enter 引导，Shift + Enter 换行' : 'Enter 发送，Shift + Enter 换行'}
                textareaRef={promptTextareaRef}
                rows={1}
                style={{ lineHeight: '1.75rem' }}
                value={prompt}
              />
              <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2">
                {planStatus && <DropdownMenu><DropdownMenuTrigger asChild><Button aria-label="查看 Plan 模式详情" className="h-auto px-0 py-0 text-xs text-muted-foreground" size="sm" type="button" variant="ghost">{planStatus}</Button></DropdownMenuTrigger><DropdownMenuContent align="start" side="top" className="max-w-xs"><p className="px-2 py-1.5 text-sm font-medium">Plan mode</p><p className="px-2 pb-2 text-xs text-muted-foreground">{planPolicy ?? '当前阶段未提供工具列表。'}</p></DropdownMenuContent></DropdownMenu>}
                {extensionStatus && <span className="text-xs text-muted-foreground">{extensionStatus}</span>}
                <div className="ml-auto flex max-w-full items-center gap-2">
                  {selectedSession && <SessionStatistics key={`statistics:${selectedSessionId}`} open={commandPanels.sessionId === selectedSessionId && commandPanels.statistics} onOpenChange={(statistics) => setCommandPanels((panels) => ({ ...panels, sessionId: selectedSessionId, statistics }))} details={runtimeStatistics} onRetry={() => void sessionRuns.getSessionStatistics(selectedSessionId)} />}

                  <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen} key={`model:${selectedSessionId}`} label={modelLabel} title={currentModel?.provider && currentModel.id ? `${currentModel.provider}/${currentModel.id}` : modelLabel} disabled={!selectedSession} models={models} currentModel={currentModel} status={modelStatus} error={modelError} isActive={isActive} onLoad={() => void openModels()} onRetry={() => void openModels(true)} onSelect={changeModel} />
                  <ThinkingSelector key={`thinking:${selectedSessionId}`} open={thinkingOpen} onOpenChange={setThinkingOpen} current={currentThinkingLevel} levels={thinkingLevels} status={thinkingStatus} error={thinkingError} failure={thinkingFailure} disabled={!selectedSession || modelStatus === 'loading' || modelStatus === 'switching'} isActive={isActive} onLoad={() => void openThinking()} onRetry={() => void openThinking(true)} onSelect={changeThinkingLevel} />
                  {isActive && status !== 'aborting' && <Button aria-label="停止生成" className="rounded-full" onClick={() => void abortPrompt()} size="icon-lg" type="button" variant="destructive"><Square aria-hidden="true" /></Button>}
                  {status === 'aborting' && <span className="text-sm text-muted-foreground">正在停止…</span>}
                  {status === 'running' && prompt.trim().length > 0 && <Button className="rounded-full" disabled={submittingInput || commands.busy} onClick={() => submitPrompt()} title={parseComposerCommand(prompt) ? '执行输入的命令' : '当前任务完成后执行'} type="button">{submittingInput ? '提交中…' : parseComposerCommand(prompt) ? '执行命令' : '排队'}</Button>}
                  {!isActive && (
                    <Button aria-label="发送提示词" className="rounded-full" disabled={commands.busy || (!selectedSession && !isDraft) || creatingDraft || modelStatus === 'loading' || modelStatus === 'switching' || thinkingStatus === 'loading' || thinkingStatus === 'switching' || prompt.trim().length === 0} onClick={() => submitPrompt()} size="icon-lg" type="button"><Send aria-hidden="true" /></Button>
                  )}
                </div>
                </div>
                </div>
              </div>
            </div>
          </div>}
        </section>
        <aside aria-hidden={isHome || !currentPreview || !inspectorOpen} className={`relative hidden min-h-0 min-w-0 bg-card/60 xl:block ${!isHome && currentPreview && inspectorOpen ? 'border-l' : 'pointer-events-none'}`} inert={isHome || !currentPreview || !inspectorOpen}>
          {!isHome && currentPreview && inspectorOpen && <FilePreviewResizeHandle containerRef={workspaceGrid} navigationWidth={navigationWidth} width={inspectorWidth} onWidthChange={setInspectorWidth} />}
          <div className="h-full min-h-0 overflow-hidden">{filePreview}</div>
        </aside>
      </div>
    </main></OpenToolFile>
  )
}

export function PendingInputs({ inputs, onSteer, disabled = false }: { inputs: PendingInput[]; onSteer?: (inputId: string) => void; disabled?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const pending = inputs.filter((input) => input.mode === 'follow_up')
  if (pending.length === 0) return null
  return <section aria-label="待处理消息" aria-live="polite" className="pointer-events-auto mb-2 rounded-xl border bg-background/95 px-3 py-2 text-xs">
    <ul className="max-h-32 space-y-1 overflow-y-auto">{(expanded ? pending : pending.slice(0, 2)).map((input) => <li className="flex min-w-0 items-center gap-2" key={input.id}><span className="shrink-0 text-muted-foreground">{input.submitting ? '正在提交' : input.mode === 'steer' ? '引导待生效' : '已排队'}</span><span className={expanded ? 'min-w-0 flex-1 whitespace-pre-wrap break-words' : 'min-w-0 flex-1 truncate'} title={input.message}>{input.message}</span>{input.mode === 'follow_up' && onSteer && <Button className="h-auto shrink-0 px-2 py-1 text-xs" disabled={disabled || input.submitting} onClick={() => onSteer(input.id)} type="button" variant="ghost">引导</Button>}</li>)}</ul>
    {pending.length > 2 && <Button className="mt-1 h-auto p-0 text-xs text-muted-foreground" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} type="button" variant="ghost">{expanded ? '收起' : `还有 ${pending.length - 2} 条`}</Button>}
  </section>
}
