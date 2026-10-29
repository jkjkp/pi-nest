import { useWorkspaceFilePreview } from './use-workspace-file-preview.js'
import { WorkspaceLayout } from './workspace-layout.js'
import { WorkspaceNavigation } from './workspace-navigation.js'
import { WorkspaceComposer } from './workspace-composer.js'
import { WorkspaceFilePreview, WorkspaceFilePreviewToggle } from './workspace-file-preview.js'
import { attachmentDrop } from './attachment-draft.js'
import { OpenToolFile } from './tool-file-context.js'
import { ProjectDialog } from './project-dialog.js'
import { ProjectHome } from './project-home.js'
import { SessionForkDialog } from './session-fork-dialog.js'
import { RenderErrorBoundary } from './render-error-boundary.js'
import { useWorkspaceCommands } from './use-workspace-commands.js'
import { SessionRenameDialog } from './session-rename-dialog.js'
import { SessionStatistics } from './session-statistics.js'
import { useCallback, useRef, useState } from 'react'
import { ArrowDown, CircleX, Folder, LoaderCircle } from 'lucide-react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

import { ThinkingSelector } from './thinking-selector.js'
import { ModelSelector } from './model-selector.js'
import { SessionInspector } from './session-inspector.js'
import type { SessionRunController } from './session-run-controller.js'
import { SessionTimeline } from './session-timeline.js'
import { useWorkspaceStore } from './workspace-store.js'
import { useWorkspaceSession } from './use-workspace-session.js'
import { useTimelineViewport } from './use-timeline-viewport.js'
import { sessionDisplayName, sessionStatusLabel } from './workspace.js'

export function WorkspacePage({ sessionRuns }: { sessionRuns: SessionRunController }) {
  const session = useWorkspaceSession(sessionRuns)
  const navigate = useNavigate()
  const {
    attachmentDraft, selectedSessionId, selectedSession, sessionResolution, draftProject, isDraft, prompt, currentRun, activeTurn, currentModel, modelLabel, modelStatus, modelError, status, isActive, isStreaming,
    extensionStatus, extensionWidget, planStatus, planPolicy, runtimeStatus, runtimeStates, runs, projects, collapsedProjectKeys,
    navigationOrder, setNavigationOrder, setProjectCollapsed, setDraft, setDraftPrompt,
    mutatingSessionId, creatingDraft, draftError, controlError, models, thinkingLevels, thinkingOpen, setThinkingOpen, thinkingStatus, thinkingError, thinkingFailure, currentThinkingLevel,
    sessionsQuery, projectsQuery, historyQuery, history, historyError, planTurnId, turnIndexQuery, navigationNotice, retryNavigation, pendingJump, jumpError, cancelTurnJump, finishTurnJump,
    startDraft, openProject, removeProject, steerQueued, retrySteering, submittingInput, abortPrompt, openModels, openThinking, handleRename, handleDelete,
    readTurnPrompt, requestTurnJump, openProjectFolder, changeModel, changeThinkingLevel, loadEarlier, retryHistory,
  } = session
  const [attachmentError, setAttachmentError] = useState<string>()
  const isHome = !selectedSessionId && !isDraft
  const displaySession = selectedSession ?? history?.session
  const sessionTitle = displaySession ? sessionDisplayName(displaySession) : selectedSessionId ? sessionResolution === 'missing' ? '会话暂不可用' : '正在恢复会话…' : draftProject ? `新对话 · ${draftProject.name}` : '项目'
  const runtimeStatistics = useWorkspaceStore((state) => state.runtimeStatistics[selectedSessionId])
  const runtimeLoading = runtimeStates[selectedSessionId]?.lifecycle === 'loading'
  const watchReady = useWorkspaceStore((state) => state.watchStates[selectedSessionId] === 'ready')
  const workspaceGrid = useRef<HTMLDivElement>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [modelSelector, setModelSelector] = useState<{ sessionId?: string; open: boolean }>({ open: false })
  const modelSelectorKey = selectedSessionId || draftProject?.key
  const modelSelectorOpen = modelSelector.sessionId === modelSelectorKey && modelSelector.open
  const setModelSelectorOpen = (open: boolean) => setModelSelector({ sessionId: modelSelectorKey, open })
  const {
    setComposer, showScrollToBottom, scrollToBottom, setFollowingLatest, railOverlay, scrollViewport, setMessageScrollArea, setRailOverlayRoot,
    scrollToFinalAnswer, followFinalAnswer, beginTurnNavigation, rememberLayoutPosition, restoreLayoutPosition,
    rememberReadingPosition, registerTimelineScroll,
  } = useTimelineViewport({ selectedSessionId, history, activeTurn, latestSteeringId: currentRun?.turns.findLast((turn) => turn.steering)?.id, isActive, pendingJump, onCancelTurnJump: cancelTurnJump })
  const navigateToTurn = useCallback((turnId: string, cursor?: string, loaded = false) => {
    beginTurnNavigation()
    return requestTurnJump(turnId, cursor, loaded)
  }, [beginTurnNavigation, requestTurnJump])
  const preview = useWorkspaceFilePreview(selectedSessionId || (draftProject ? `project:${draftProject.cwd}` : 'home'), rememberLayoutPosition, restoreLayoutPosition, { cwd: displaySession?.cwd ?? draftProject?.cwd, scope: selectedSessionId ? { kind: 'session', id: selectedSessionId } : draftProject?.cwd ? { kind: 'project', cwd: draftProject.cwd } : undefined })
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null)

  const [commandPanels, setCommandPanels] = useState<{ sessionId: string; statistics: boolean; fork?: (entryId: string, revision: string) => Promise<void>; rename?: { session: NonNullable<typeof selectedSession> } }>({ sessionId: selectedSessionId, statistics: false })
  if (commandPanels.sessionId !== selectedSessionId) setCommandPanels({ sessionId: selectedSessionId, statistics: false })
  const commands = useWorkspaceCommands(session, sessionRuns, {
    fork: (onFork) => setCommandPanels({ sessionId: selectedSessionId, statistics: false, fork: onFork }),
    rename: () => { if (selectedSession) setCommandPanels({ sessionId: selectedSessionId, statistics: false, rename: { session: selectedSession } }) },
    statistics: () => setCommandPanels({ sessionId: selectedSessionId, statistics: true }),
    settings: () => { void navigate(`/settings?session=${encodeURIComponent(selectedSessionId)}`) },
  })

  function selectSession(sessionId: string) {
    rememberReadingPosition()
    session.selectSession(sessionId)
  }

  function submitPrompt(mode: 'follow_up' | 'steer' = 'follow_up') {
    if ((!selectedSessionId && !isDraft) || (!prompt.trim() && !attachmentDraft.items.length)) return
    if (!attachmentDraft.items.length && commands.submit(prompt)) return
    if (mode !== 'steer') setFollowingLatest(true)
    session.submitPrompt(mode)
  }

  const navigation = (
    <WorkspaceNavigation
      collapsedProjectKeys={collapsedProjectKeys}
      error={sessionsQuery.error}
      isLoading={sessionsQuery.isPending}
      mutationSessionId={mutatingSessionId}
      onClone={async (sessionId) => {
        const result = await session.createBranch({ kind: 'clone' }, sessionId)
        selectSession(result.session.id)
      }}
      onDelete={handleDelete}
      onAddProject={() => setCreatingProject(true)}
      onNewConversation={startDraft}
      onProjectOrderChange={(projectOrder) => setNavigationOrder({ ...navigationOrder, projectOrder })}
      onRemoveProject={removeProject}
      onRename={handleRename}
      onRevealProject={openProjectFolder}
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
      settingsHref={selectedSession ? `/settings?session=${encodeURIComponent(selectedSession.id)}` : '/settings'}
    />
  )

  return (
    <OpenToolFile value={preview.openFile}>
      {creatingProject && <ProjectDialog mode="register" onClose={() => setCreatingProject(false)} onAdded={openProject} />}
      {commandPanels.sessionId === selectedSessionId && commandPanels.fork && <SessionForkDialog key={`fork:${selectedSessionId}`} sessionId={selectedSessionId} onClose={() => setCommandPanels({ sessionId: selectedSessionId, statistics: false })} onCloseAutoFocus={(event) => { event.preventDefault(); requestAnimationFrame(() => promptTextareaRef.current?.focus()) }} onFork={commandPanels.fork} />}
      {commandPanels.sessionId === selectedSessionId && commandPanels.rename && <SessionRenameDialog key={selectedSessionId} session={commandPanels.rename.session} onCloseAutoFocus={(event) => { event.preventDefault(); promptTextareaRef.current?.focus() }} onClose={() => setCommandPanels({ sessionId: selectedSessionId, statistics: false })} onRename={async (id, name) => {
        if (isActive || ['loading', 'switching'].includes(modelStatus) || ['loading', 'switching'].includes(thinkingStatus)) throw new Error('请等待当前会话操作结束。')
        await handleRename(id, name)
      }} />}
      <WorkspaceLayout title={sessionTitle} titleTooltip={displaySession ? sessionDisplayName(displaySession) : undefined}
        navigation={navigation} containerRef={workspaceGrid} previewOpen={preview.open}
        preview={<WorkspaceFilePreview preview={preview} containerRef={workspaceGrid} />}>
        <section onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={(event) => { try { attachmentDrop(event, attachmentDraft.add) } catch (cause) { setAttachmentError(cause instanceof Error ? cause.message : '附件无法添加') } }} className="relative flex min-h-0 min-w-0 flex-col [--composer-height:132px]">
          <header className="flex min-h-10 shrink-0 items-center gap-3 border-b bg-background/95 py-0.5 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:pl-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {(selectedSession || draftProject) && <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
              <h1 className="min-w-0 truncate text-[13px] leading-5 font-normal" title={displaySession ? sessionDisplayName(displaySession) : undefined}>{sessionTitle}</h1>
              {selectedSession && <span className="inline-flex size-4 shrink-0" role={runtimeLoading ? 'status' : undefined} aria-label={runtimeLoading ? '正在加载 Pi 运行时' : undefined}>{runtimeLoading && <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />}</span>}
            </div>
            <WorkspaceFilePreviewToggle open={preview.open} onToggle={preview.toggle} buttonRef={preview.toggleRef} />
            {selectedSessionId && <SessionInspector key={selectedSessionId} run={currentRun} session={displaySession} />}
          </header>
          <div className="relative min-h-0 flex-1" ref={setMessageScrollArea}>
            <ScrollArea className="timeline-scroll h-full">
              <div className={isHome ? "w-full" : "w-full space-y-4 px-4 pt-6 pb-[calc(var(--composer-height)+3rem)] sm:px-6"}>
                {(sessionResolution === 'error' || sessionResolution === 'missing') && <div className="conversation-stage"><div className="conversation-stage-content flex items-center gap-2 text-sm text-muted-foreground" role="status"><span>{sessionResolution === 'error' ? '会话列表读取失败，已保留当前会话。' : '当前会话未出现在列表中，已保留现有内容。'}</span><Button type="button" size="sm" variant="ghost" onClick={() => void sessionsQuery.refetch()}>重试会话列表</Button></div></div>}
                {isDraft ? (
                  <div className="conversation-stage py-16">
                    <section className="conversation-stage-content grid min-h-56 place-items-center rounded-2xl border border-dashed bg-muted/20 p-8 text-center">
                      <div className="space-y-2"><h2 className="text-lg font-normal">在 {draftProject?.name} 开始新对话</h2><p className="text-sm text-muted-foreground">发送第一条消息后才会创建 Pi 会话。</p></div>
                    </section>
                  </div>
                ) : selectedSessionId ? <RenderErrorBoundary key={selectedSessionId} scope="timeline" sessionId={selectedSessionId}><SessionTimeline
                  sessionId={selectedSessionId}
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
                  onRequestTurnJump={navigateToTurn}
                  onReadTurnPrompt={readTurnPrompt}
                  branchDisabled={mutatingSessionId !== undefined}
                  onBranchAnswer={async (entryId, revision) => {
                    const result = await session.createBranch({ kind: 'fork', entryId, revision })
                    selectSession(result.session.id)
                  }}
                  onRetry={retryHistory}
                  onTurnJumpFinished={finishTurnJump}
                  overlayRoot={railOverlay}
                  pendingInputs={currentRun?.pendingInputs}
                  pendingJump={pendingJump?.sessionId === selectedSessionId ? pendingJump : undefined}
                  jumpError={jumpError}
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
                        <p className="text-xs font-normal text-warning">{sessionStatusLabel(status)}</p>
                      </div>
                    )}
                    {currentRun?.error && (
                      <p className="flex items-center gap-2 rounded-lg border border-destructive/30 border-l-2 border-l-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                        <CircleX aria-hidden="true" className="size-4" />
                        {currentRun.error}
                      </p>
                    )}
                    {!currentRun?.error && runtimeStatus && <p className="text-xs text-muted-foreground" role={runtimeStates[selectedSessionId]?.lifecycle === 'failed' ? 'alert' : undefined}>{runtimeStatus}</p>}
                    {currentRun?.attachmentWarning && <p role="status" className="text-xs text-warning">{currentRun.attachmentWarning}</p>}
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
          {!isHome && <WorkspaceComposer
            state={{ creatingDraft, attachmentDraft, selectedSessionId, selectedSession, isDraft, draftProject, prompt, currentRun, history,
              setDraft, setDraftPrompt, status, isActive, submittingInput, steerQueued, planStatus, planPolicy,
              extensionStatus, planTurnId, retryHistory, requestTurnJump: navigateToTurn }}
            commands={commands} sessionRuns={sessionRuns} textareaRef={promptTextareaRef} setComposer={setComposer}
            onSubmit={submitPrompt} onAbort={() => { void abortPrompt() }} error={attachmentError} onError={setAttachmentError}
            settingsBusy={modelStatus === 'loading' || modelStatus === 'switching' || thinkingStatus === 'loading' || thinkingStatus === 'switching'}
            canQuery={!commands.busy && watchReady && ['idle', 'active'].includes(runtimeStates[selectedSessionId]?.lifecycle ?? '') && modelStatus !== 'loading' && modelStatus !== 'switching' && thinkingStatus !== 'loading' && thinkingStatus !== 'switching'}
            controls={<>
                  {selectedSession && <SessionStatistics key={`statistics:${selectedSessionId}`} open={commandPanels.sessionId === selectedSessionId && commandPanels.statistics} onOpenChange={(statistics) => setCommandPanels((panels) => ({ ...panels, sessionId: selectedSessionId, statistics }))} details={runtimeStatistics} onRetry={() => void sessionRuns.getSessionStatistics(selectedSessionId)} />}

                  <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen} key={`model:${selectedSessionId || draftProject?.key}`} label={modelLabel} title={currentModel?.provider && currentModel.id ? `${currentModel.provider}/${currentModel.id}` : modelLabel} disabled={(!selectedSession && !isDraft) || creatingDraft} models={models} currentModel={currentModel} status={modelStatus} error={modelError} isActive={isActive} onLoad={() => void openModels()} onRetry={() => void openModels(true)} onSelect={changeModel} />
                  <ThinkingSelector emptyMessage={isDraft && !currentModel ? '请先选择模型，再设置思考等级。' : undefined} key={`thinking:${selectedSessionId || draftProject?.key}`} open={thinkingOpen} onOpenChange={setThinkingOpen} current={currentThinkingLevel} levels={thinkingLevels} status={thinkingStatus} error={thinkingError} failure={thinkingFailure} disabled={(!selectedSession && !isDraft) || creatingDraft || (!isDraft && (modelStatus === 'loading' || modelStatus === 'switching'))} isActive={isActive} onLoad={() => void openThinking()} onRetry={() => void openThinking(true)} onSelect={changeThinkingLevel} />
            </>}
          />}
        </section>
      </WorkspaceLayout>
    </OpenToolFile>
  )
}
