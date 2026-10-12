import { type CSSProperties, useEffect, useState } from 'react'
import { ArrowDown, CircleX, Folder, Menu, PanelRight, Send, Settings, Square } from 'lucide-react'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'

import { useComposerTextarea } from './composer-textarea.js'
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

export function WorkspacePage({ sessionRuns }: { sessionRuns: SessionRunController }) {
  const session = useWorkspaceSession(sessionRuns)
  const {
    selectedSessionId, selectedSession, draftProject, isDraft, prompt, currentRun, activeTurn, currentModel, modelLabel, modelStatus, modelError, status, isActive, isStreaming,
    extensionStatus, extensionWidget, runtimeStatus, runtimeStates, runs, projects, removedProjects, collapsedProjectKeys,
    navigationOrder, setNavigationOrder, setProjectCollapsed, restoreProject, setDraft, setDraftPrompt,
    mutatingSessionId, creatingDraft, draftError, controlError, models, thinkingLevels, thinkingOpen, setThinkingOpen, thinkingStatus, thinkingError, thinkingFailure, currentThinkingLevel, queueMode, setQueueMode,
    sessionsQuery, historyQuery, history, turnIndexQuery, pendingJump, setPendingJump,
    startDraft, removeProject, abortPrompt, openModels, openThinking, handleRename, handleDelete,
    readTurnPrompt, jumpToUnloadedTurn, revealProjectInFinder, changeModel, changeThinkingLevel, loadEarlier, retryHistory,
  } = session
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen)
  const inspectorWidth = useWorkspaceStore((state) => state.inspectorWidth)
  const navigationOpen = useWorkspaceStore((state) => state.navigationOpen)
  const navigationWidth = useWorkspaceStore((state) => state.navigationWidth)
  const setInspectorOpen = useWorkspaceStore((state) => state.setInspectorOpen)
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  const [modelSelector, setModelSelector] = useState<{ sessionId?: string; open: boolean }>({ open: false })
  const modelSelectorOpen = modelSelector.sessionId === selectedSessionId && modelSelector.open
  const setModelSelectorOpen = (open: boolean) => setModelSelector({ sessionId: selectedSessionId, open })
  const [inspectorSheetOpen, setInspectorSheetOpen] = useState(false)
  const [desktopInspectorSheetOpen, setDesktopInspectorSheetOpen] = useState(false)
  const {
    setComposer, showScrollToBottom, scrollToBottom, setFollowingLatest, railOverlay, scrollViewport, setMessageScrollArea, setRailOverlayRoot,
    scrollToFinalAnswer, followFinalAnswer, jumpToTurn, toggleInspector,
  } = useTimelineViewport({ selectedSessionId, history, activeTurn, isActive, inspectorOpen, setInspectorOpen })
  const promptTextareaRef = useComposerTextarea(prompt)

  function selectSession(sessionId: string) {
    setFollowingLatest(true)
    session.selectSession(sessionId)
  }

  function submitPrompt() {
    if ((!selectedSessionId && !isDraft) || !prompt.trim()) return
    setFollowingLatest(true)
    session.submitPrompt()
  }

  useEffect(() => {
    const media = window.matchMedia('(min-width: 80rem)')
    const closeSheetOnDesktop = () => {
      if (!media.matches) return
      setInspectorSheetOpen(false)
      setDesktopInspectorSheetOpen(false)
    }
    closeSheetOnDesktop()
    media.addEventListener('change', closeSheetOnDesktop)
    return () => media.removeEventListener('change', closeSheetOnDesktop)
  }, [])

  const navigation = (
    <SessionNavigation
      collapsedProjectKeys={collapsedProjectKeys}
      error={sessionsQuery.error}
      isLoading={sessionsQuery.isPending}
      mutationSessionId={mutatingSessionId}
      onDelete={handleDelete}
      onNewConversation={startDraft}
      onProjectOrderChange={(projectOrder) => setNavigationOrder({ ...navigationOrder, projectOrder })}
      onRemoveProject={removeProject}
      onRename={handleRename}
      onRestoreProject={restoreProject}
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
      removedProjects={removedProjects}
      runs={runs}
      selectedSessionId={selectedSessionId}
    />
  )
  const inspector = <SessionInspector run={currentRun} session={selectedSession} />

  return (
    <main className="relative flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
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
          <h1 className="truncate text-sm font-semibold tracking-tight" title={selectedSession ? sessionDisplayName(selectedSession) : undefined}>{selectedSession ? sessionDisplayName(selectedSession) : 'Pi Nest'}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {selectedSession && <Button asChild size="sm" variant="ghost"><Link to={`/settings?session=${encodeURIComponent(selectedSession.id)}`}><Settings aria-hidden="true" />设置</Link></Button>}
          <Sheet open={inspectorSheetOpen} onOpenChange={setInspectorSheetOpen}>
            <SheetTrigger asChild>
              <Button aria-label="打开会话检查器" className="xl:hidden" size="icon-sm" variant="ghost"><PanelRight aria-hidden="true" /></Button>
            </SheetTrigger>
            <SheetContent className="p-0" side="right">
              <SheetTitle className="sr-only">会话检查器</SheetTitle>
              <SheetDescription className="sr-only">当前会话的运行摘要与元信息。</SheetDescription>
              {inspector}
            </SheetContent>
          </Sheet>
          <Button aria-label={inspectorOpen ? '收起会话检查器' : '展开会话检查器'} className="hidden xl:inline-flex" onClick={toggleInspector} onPointerDown={(event) => event.preventDefault()} size="icon-sm" type="button" variant="ghost"><PanelRight aria-hidden="true" /></Button>
        </div>
      </header>

      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden h-14 items-center justify-end px-3 sm:px-4 md:flex">
        <Sheet open={desktopInspectorSheetOpen} onOpenChange={setDesktopInspectorSheetOpen}>
          <SheetTrigger asChild>
            <Button aria-label="打开会话检查器" className="pointer-events-auto xl:hidden" size="icon-sm" variant="ghost"><PanelRight aria-hidden="true" /></Button>
          </SheetTrigger>
          <SheetContent className="p-0" side="right">
            <SheetTitle className="sr-only">会话检查器</SheetTitle>
            <SheetDescription className="sr-only">当前会话的运行摘要与元信息。</SheetDescription>
            {inspector}
          </SheetContent>
        </Sheet>
        <Button aria-label={inspectorOpen ? '收起会话检查器' : '展开会话检查器'} className="pointer-events-auto hidden xl:inline-flex" onClick={toggleInspector} onPointerDown={(event) => event.preventDefault()} size="icon-sm" type="button" variant="ghost"><PanelRight aria-hidden="true" /></Button>
      </div>

      <div
        className="workspace-grid grid min-h-0 flex-1"
        style={{ '--inspector-width': `${inspectorWidth}px`, '--navigation-width': `${navigationWidth}px`, '--side-panel-width': inspectorOpen ? `${inspectorWidth}px` : '0px' } as CSSProperties}
      >
        <aside className="hidden min-h-0 border-r bg-card/60 md:block">{navigation}</aside>
        <section className="relative flex min-h-0 min-w-0 flex-col [--composer-height:132px]">
          <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-background/95 py-2 pr-16 pl-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:pl-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {(selectedSession || draftProject) && <Folder aria-hidden="true" className="size-[18px] shrink-0 text-muted-foreground" />}
              <h1 className="min-w-0 truncate text-base font-semibold" title={selectedSession ? sessionDisplayName(selectedSession) : undefined}>{selectedSession ? sessionDisplayName(selectedSession) : draftProject ? `新对话 · ${draftProject.name}` : '选择一个会话'}</h1>
            </div>
            {selectedSession && <Button asChild className="shrink-0" size="sm" variant="ghost"><Link to={`/settings?session=${encodeURIComponent(selectedSession.id)}`}><Settings aria-hidden="true" />设置</Link></Button>}
          </header>
          <div className="relative min-h-0 flex-1" ref={setMessageScrollArea}>
            <ScrollArea className="timeline-scroll h-full">
              <div className="w-full space-y-4 px-4 pt-6 pb-[calc(var(--composer-height)+3rem)] sm:px-6">
                {isDraft ? (
                  <div className="conversation-stage py-16">
                    <section className="conversation-stage-content grid min-h-56 place-items-center rounded-2xl border border-dashed bg-muted/20 p-8 text-center">
                      <div className="space-y-2"><h2 className="text-lg font-semibold">在 {draftProject?.name} 开始新对话</h2><p className="text-sm text-muted-foreground">发送第一条消息后才会创建 Pi 会话。</p></div>
                    </section>
                  </div>
                ) : selectedSession ? <SessionTimeline
                  onSelectModel={() => { setModelSelectorOpen(true); void openModels() }}
                  error={historyQuery.isError && !history}
                  hasEarlier={historyQuery.hasPreviousPage}
                  history={history}
                  isLoading={!isStreaming && !history && historyQuery.isPending}
                  isLoadingEarlier={historyQuery.isFetchingPreviousPage}
                  isRunning={isStreaming}
                  onLoadEarlier={loadEarlier}
                  onFinalAnswerStart={scrollToFinalAnswer}
                  onFinalAnswerStream={followFinalAnswer}
                  onJumpToTurn={jumpToTurn}
                  onReadTurnPrompt={readTurnPrompt}
                  onJumpToUnloadedTurn={jumpToUnloadedTurn}
                  onRetry={retryHistory}
                  onPendingJumpHandled={() => setPendingJump(undefined)}
                  overlayRoot={railOverlay}
                  pendingInputs={currentRun?.pendingInputs}
                  pendingJumpTurnId={pendingJump?.sessionId === selectedSessionId ? pendingJump.turnId : undefined}
                  scrollViewport={scrollViewport}
                  systemEvents={currentRun?.systemEvents}
                  runStatus={status}
                  runMessage={currentRun?.waitingMessage}
                  turnIndex={turnIndexQuery.data}
                  turns={currentRun?.turns}
                /> : <div className="conversation-stage py-16"><p className="conversation-stage-content text-center text-sm text-muted-foreground">从左侧选择一个会话，或在项目中创建新对话。</p></div>}
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
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-transparent px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6" ref={setComposer} data-slot="composer">
            <div className="conversation-stage">
              <div className="conversation-stage-content">
                <div className="pointer-events-auto"><ExtensionUiInline sessionId={selectedSessionId} /></div>
                <div className="pointer-events-auto flex min-h-[100px] w-full flex-col justify-between gap-1 rounded-[2.5rem] border bg-muted px-5 py-3 shadow-sm dark:border-white/10 dark:bg-[#303030] sm:px-6">
              <label className="sr-only" htmlFor="prompt">{isDraft ? '输入新对话的第一条提示词' : '向当前 Pi 会话发送提示词'}</label>
              <Textarea
                className="min-h-0! shrink-0 resize-none border-0 bg-transparent px-0 py-0 text-[16px] leading-7 shadow-none placeholder:text-muted-foreground/70 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
                disabled={(!selectedSession && !isDraft) || creatingDraft}
                id="prompt"
                maxLength={20_000}
                onChange={(event) => isDraft ? setDraftPrompt(event.target.value) : selectedSessionId && setDraft(selectedSessionId, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return

                  event.preventDefault()
                  submitPrompt()
                }}
                placeholder={isDraft ? '随心输入…' : 'Enter 发送，Shift + Enter 换行'}
                ref={promptTextareaRef}
                rows={1}
                style={{ lineHeight: '1.75rem' }}
                value={prompt}
              />
              <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2">
                {extensionStatus && <span className="text-xs text-muted-foreground">{extensionStatus}</span>}
                {isActive && <div className="flex gap-1 text-xs"><Button onClick={() => setQueueMode('steer')} size="sm" type="button" variant={queueMode === 'steer' ? 'secondary' : 'ghost'}>Steer</Button><Button onClick={() => setQueueMode('follow_up')} size="sm" type="button" variant={queueMode === 'follow_up' ? 'secondary' : 'ghost'}>Follow-up</Button></div>}
                <div className="ml-auto flex items-center gap-2">
                  <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen} key={selectedSessionId} label={modelLabel} title={currentModel?.provider && currentModel.id ? `${currentModel.provider}/${currentModel.id}` : modelLabel} disabled={!selectedSession} models={models} currentModel={currentModel} status={modelStatus} error={modelError} isActive={isActive} onLoad={() => void openModels()} onRetry={() => void openModels(true)} onSelect={changeModel} />
                  <ThinkingSelector key={`thinking:${selectedSessionId}`} open={thinkingOpen} onOpenChange={setThinkingOpen} current={currentThinkingLevel} levels={thinkingLevels} status={thinkingStatus} error={thinkingError} failure={thinkingFailure} disabled={!selectedSession || modelStatus === 'loading' || modelStatus === 'switching'} isActive={isActive} onLoad={() => void openThinking()} onRetry={() => void openThinking(true)} onSelect={changeThinkingLevel} />
                  {isActive && status !== 'aborting' && <Button aria-label="停止生成" className="rounded-full" onClick={() => void abortPrompt()} size="icon-lg" type="button" variant="destructive"><Square aria-hidden="true" /></Button>}
                  {status === 'aborting' && <span className="text-sm text-muted-foreground">正在停止…</span>}
                  {status === 'running' && <Button aria-label={queueMode === 'steer' ? '发送 Steer' : '发送 Follow-up'} className="rounded-full" disabled={prompt.trim().length === 0} onClick={() => submitPrompt()} size="icon-lg" type="button"><Send aria-hidden="true" /></Button>}
                  {!isActive && (
                    <Button aria-label="发送提示词" className="rounded-full" disabled={(!selectedSession && !isDraft) || creatingDraft || modelStatus === 'loading' || modelStatus === 'switching' || thinkingStatus === 'loading' || thinkingStatus === 'switching' || prompt.trim().length === 0} onClick={() => submitPrompt()} size="icon-lg" type="button"><Send aria-hidden="true" /></Button>
                  )}
                </div>
                </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <aside aria-hidden={!inspectorOpen} className={`hidden min-h-0 overflow-hidden bg-card/60 xl:block ${inspectorOpen ? 'border-l' : 'pointer-events-none'}`} inert={!inspectorOpen}>{inspector}</aside>
      </div>
    </main>
  )
}
