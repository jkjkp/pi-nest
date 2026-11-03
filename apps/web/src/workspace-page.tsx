import { SessionGraphWorkspace } from './session-graph-workspace.js'
import type { GraphSelection } from './session-graph-preview.js'
import { useWorkspaceFilePreview } from './use-workspace-file-preview.js'
import { WorkspaceLayout } from './workspace-layout.js'
import { WorkspaceNavigation } from './workspace-navigation.js'
import { NavigationToggle } from './navigation-toggle.js'
import { MessageEditor } from './message-editor.js'
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
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
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
  const workspaceView = useWorkspaceStore((state) => state.workspaceView)
  const navigationCollapsed = useWorkspaceStore((state) => state.navigationCollapsed)
  const setNavigationCollapsed = useWorkspaceStore((state) => state.setNavigationCollapsed)
  const setWorkspaceView = useWorkspaceStore((state) => state.setWorkspaceView)
  const branchStorage = useWorkspaceStore((state) => state.branchStorage)
  const pendingBranch = useWorkspaceStore((state) => state.branchOperations[selectedSessionId])
  const currentSessionRef = useRef(selectedSessionId)
  useLayoutEffect(() => { currentSessionRef.current = selectedSessionId }, [selectedSessionId])
  const [graphState, setGraphState] = useState<{ owner: string; selection?: GraphSelection }>()
  const graphSelection = graphState?.owner === selectedSessionId && graphState.selection?.sessionId !== selectedSessionId ? graphState.selection : undefined
  const graphIntentRef = useRef(graphState)
  useLayoutEffect(() => { graphIntentRef.current = graphState }, [graphState])
  function setGraphSelection(selection?: GraphSelection) {
    const next = { owner: selectedSessionId, selection: selection?.sessionId === selectedSessionId ? undefined : selection }
    setGraphState(next)
    return next
  }
  const ordinaryDraft = useWorkspaceStore((state) => state.drafts[selectedSessionId] ?? '')
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
  const preview = useWorkspaceFilePreview((workspaceView === 'tree' ? graphSelection?.sessionId : undefined) || selectedSessionId || (draftProject ? `project:${draftProject.cwd}` : 'home'), rememberLayoutPosition, restoreLayoutPosition, { cwd: displaySession?.cwd ?? draftProject?.cwd, scope: selectedSessionId ? { kind: 'session', id: workspaceView === 'tree' ? graphSelection?.sessionId ?? selectedSessionId : selectedSessionId } : draftProject?.cwd ? { kind: 'project', cwd: draftProject.cwd } : undefined })
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null)

  const [commandPanels, setCommandPanels] = useState<{ sessionId: string; statistics: boolean; fork?: (entryId: string, revision: string) => Promise<void>; rename?: { session: NonNullable<typeof selectedSession> } }>({ sessionId: selectedSessionId, statistics: false })
  if (commandPanels.sessionId !== selectedSessionId) setCommandPanels({ sessionId: selectedSessionId, statistics: false })
  const commands = useWorkspaceCommands(session, sessionRuns, {
    fork: (onFork) => setCommandPanels({ sessionId: selectedSessionId, statistics: false, fork: onFork }),
    rename: () => { if (selectedSession) setCommandPanels({ sessionId: selectedSessionId, statistics: false, rename: { session: selectedSession } }) },
    statistics: () => setCommandPanels({ sessionId: selectedSessionId, statistics: true }),
    settings: () => { void navigate(`/settings?session=${encodeURIComponent(selectedSessionId)}`) },
  })

  function showGraphPreview(selection?: GraphSelection) {
    if (selection && selection.sessionId !== selectedSessionId && !graphSelection) { rememberReadingPosition(); rememberLayoutPosition() }
    const intent = setGraphSelection(selection)
    if (!intent.selection) requestAnimationFrame(() => {
      if (currentSessionRef.current === intent.owner && graphIntentRef.current === intent) restoreLayoutPosition()
    })
  }

  function showCurrentGraphSession() {
    const intent = setGraphSelection(undefined)
    requestAnimationFrame(() => {
      if (currentSessionRef.current !== intent.owner || graphIntentRef.current !== intent || !scrollViewport?.isConnected) return
      setFollowingLatest(true)
      scrollViewport?.scrollTo({ top: scrollViewport.scrollHeight, behavior: 'instant' })
    })
  }

  function selectSession(sessionId: string) {
    if (!graphSelection) rememberReadingPosition()
    setGraphSelection(undefined)
    session.selectSession(sessionId)
  }

  async function cloneSession(sessionId: string) {
    const original = graphIntentRef.current
    const result = await session.createBranch({ kind: 'clone' }, sessionId)
    if (currentSessionRef.current === selectedSessionId && graphIntentRef.current === original) selectSession(result.session.id)
  }

  function submitPrompt(mode: 'follow_up' | 'steer' = 'follow_up') {
    if (session.messageEdit) return
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
      onClone={cloneSession}
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
        <section onDragOver={(event) => { if (graphSelection) return; if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={(event) => { if (graphSelection) { event.preventDefault(); return } if (session.messageEdit && session.messageEdit.status !== 'editing') { event.preventDefault(); return } try { attachmentDrop(event, attachmentDraft.add) } catch (cause) { setAttachmentError(cause instanceof Error ? cause.message : '附件无法添加') } }} className="relative flex min-h-0 min-w-0 flex-col [--composer-height:132px]">
          <header className="flex min-h-10 shrink-0 items-center gap-3 border-b bg-background/95 py-0.5 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:pl-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {navigationCollapsed && <span data-navigation-restore className="hidden md:inline-flex"><NavigationToggle controls="workspace-navigation" expanded={false} onToggle={() => setNavigationCollapsed(false)} /></span>}
              {(selectedSession || draftProject) && <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
              <h1 className="min-w-0 truncate text-[13px] leading-5 font-normal" title={displaySession ? sessionDisplayName(displaySession) : undefined}>{sessionTitle}</h1>
              {selectedSession && <span className="inline-flex size-4 shrink-0" role={runtimeLoading ? 'status' : undefined} aria-label={runtimeLoading ? '正在加载 Pi 运行时' : undefined}>{runtimeLoading && <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />}</span>}
            </div>
            {selectedSessionId && <div role="group" aria-label="页面模式" className="flex shrink-0 gap-1">
              <Button size="sm" variant={workspaceView === 'chat' ? 'secondary' : 'ghost'} aria-pressed={workspaceView === 'chat'} onClick={() => { rememberLayoutPosition(); setWorkspaceView('chat'); setGraphSelection(undefined); requestAnimationFrame(restoreLayoutPosition) }}>对话</Button>
              <Button size="sm" variant={workspaceView === 'tree' ? 'secondary' : 'ghost'} aria-pressed={workspaceView === 'tree'} onClick={() => { rememberLayoutPosition(); setWorkspaceView('tree'); requestAnimationFrame(restoreLayoutPosition) }}>树状</Button>
            </div>}
            <WorkspaceFilePreviewToggle open={preview.open} onToggle={preview.toggle} buttonRef={preview.toggleRef} />
            {selectedSessionId && <SessionInspector key={selectedSessionId} run={currentRun} session={displaySession} />}
          </header>
          {!branchStorage.available && <p role="status" className="px-3 text-xs text-destructive">分支关系存储不可用，新建分支已禁用；普通对话可继续。</p>}
          {pendingBranch && mutatingSessionId !== selectedSessionId && <div className="flex items-center gap-2 px-3 text-xs" role="status">分支创建结果待确认。<Button size="sm" variant="ghost" onClick={() => { void session.checkBranch().then((result) => { if (result && currentSessionRef.current === selectedSessionId) { selectSession(result.session.id); if (result.draftRecoveryRequired) setAttachmentError('分支已创建，但来源消息不可读取，请自行恢复未发送草稿。') } }).catch((cause) => setAttachmentError(cause instanceof Error ? cause.message : '查询失败')) }}>查询分支结果</Button></div>}
          <SessionGraphWorkspace onRename={handleRename} onDelete={handleDelete} onClone={cloneSession} mutationSessionId={mutatingSessionId} enabled={workspaceView === 'tree' && Boolean(selectedSessionId)} sessionId={selectedSessionId}
            onRead={sessionRuns.markSessionRead} readBlocked={preview.open && !preview.wide} currentReadReady={watchReady && !isActive && history?.session.id === selectedSessionId && historyQuery.isSuccess && !historyQuery.isFetching && !historyError}
            selection={graphSelection} onPreview={showGraphPreview} onCurrentNodeClick={showCurrentGraphSession} onSelect={selectSession}
            onBranch={async (sourceId, request) => { const original = selectedSessionId; const previewIntent = graphIntentRef.current; const result = await session.createBranch(request, sourceId); if (useWorkspaceStore.getState().branchOperations[sourceId]) return; if (currentSessionRef.current === original && graphIntentRef.current === previewIntent) selectSession(result.session.id) }}>
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
                  editDisabled={session.editDisabled || Boolean(session.messageEdit)}
                  onEditLast={(entryId) => { setAttachmentError(undefined); void session.beginMessageEdit(entryId).catch((cause) => setAttachmentError(cause instanceof Error ? cause.message : '无法编辑消息。')) }}
                  messageEdit={session.messageEdit && { entryId: session.messageEdit.entryId, editor: <MessageEditor
                    edit={session.messageEdit} attachments={attachmentDraft} error={attachmentError} onError={setAttachmentError}
                    disabled={session.editDisabled || ['loading', 'switching'].includes(modelStatus) || ['loading', 'switching'].includes(thinkingStatus)}
                    onChange={(text) => setDraft(selectedSessionId, text)}
                    onCancel={() => { session.cancelMessageEdit(); setAttachmentError(undefined); requestAnimationFrame(() => promptTextareaRef.current?.focus()) }}
                    onSubmit={() => { if (session.messageEdit?.status === 'editing') setFollowingLatest(true); void session.submitMessageEdit() }}
                  /> }}
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
                    if (currentSessionRef.current === selectedSessionId) selectSession(result.session.id)
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
            state={{ creatingDraft, attachmentDraft, selectedSessionId, selectedSession, isDraft, draftProject, prompt: session.messageEdit ? ordinaryDraft : prompt, currentRun, history,
              messageEdit: session.messageEdit,
              setDraft, setDraftPrompt, status, isActive, submittingInput, steerQueued, planStatus, planPolicy,
              extensionStatus, planTurnId, retryHistory, requestTurnJump: navigateToTurn }}
            commands={commands} sessionRuns={sessionRuns} textareaRef={promptTextareaRef} setComposer={setComposer}
            onSubmit={submitPrompt} onAbort={() => { void abortPrompt() }} error={session.messageEdit ? undefined : attachmentError} onError={setAttachmentError}
            settingsBusy={modelStatus === 'loading' || modelStatus === 'switching' || thinkingStatus === 'loading' || thinkingStatus === 'switching'}
            canQuery={!commands.busy && watchReady && ['idle', 'active'].includes(runtimeStates[selectedSessionId]?.lifecycle ?? '') && modelStatus !== 'loading' && modelStatus !== 'switching' && thinkingStatus !== 'loading' && thinkingStatus !== 'switching'}
            controls={<>
                  {selectedSession && <SessionStatistics key={`statistics:${selectedSessionId}`} open={commandPanels.sessionId === selectedSessionId && commandPanels.statistics} onOpenChange={(statistics) => setCommandPanels((panels) => ({ ...panels, sessionId: selectedSessionId, statistics }))} details={runtimeStatistics} onRetry={() => void sessionRuns.getSessionStatistics(selectedSessionId)} />}

                  <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen} key={`model:${selectedSessionId || draftProject?.key}`} label={modelLabel} title={currentModel?.provider && currentModel.id ? `${currentModel.provider}/${currentModel.id}` : modelLabel} disabled={(!selectedSession && !isDraft) || creatingDraft || Boolean(session.messageEdit && session.messageEdit.status !== 'editing')} models={models} currentModel={currentModel} status={modelStatus} error={modelError} isActive={isActive} onLoad={() => void openModels()} onRetry={() => void openModels(true)} onSelect={changeModel} />
                  <ThinkingSelector emptyMessage={isDraft && !currentModel ? '请先选择模型，再设置思考等级。' : undefined} key={`thinking:${selectedSessionId || draftProject?.key}`} open={thinkingOpen} onOpenChange={setThinkingOpen} current={currentThinkingLevel} levels={thinkingLevels} status={thinkingStatus} error={thinkingError} failure={thinkingFailure} disabled={(!selectedSession && !isDraft) || creatingDraft || (!isDraft && (modelStatus === 'loading' || modelStatus === 'switching'))} isActive={isActive} onLoad={() => void openThinking()} onRetry={() => void openThinking(true)} onSelect={changeThinkingLevel} />
            </>}
          />}
          </SessionGraphWorkspace>
        </section>
      </WorkspaceLayout>
    </OpenToolFile>
  )
}
