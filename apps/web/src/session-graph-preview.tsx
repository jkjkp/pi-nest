import { useLayoutEffect } from 'react'
import type { PiSessionBranchRequest } from '@pi-nest/contracts'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { SessionTimeline } from './session-timeline.js'
import { useSessionHistory } from './use-session-history.js'
import { useWorkspaceStore } from './workspace-store.js'
import { activeRuntimeTurn, isRunActive } from './session-run-model.js'
import { useTimelineViewport } from './use-timeline-viewport.js'

export type GraphSelection = { sessionId: string }
export function SessionGraphPreview({ selection, cwd, branchDisabled, onBranch }: {
  selection: GraphSelection; cwd?: string; branchDisabled: boolean; onBranch: (request: PiSessionBranchRequest) => Promise<void>
}) {
  const view = useSessionHistory(selection.sessionId, true)
  const run = useWorkspaceStore((state) => state.runs[selection.sessionId])
  const pendingRunId = useWorkspaceStore((state) => state.sessionNotifications[selection.sessionId]?.pendingRunId)
  const isRunning = isRunActive(run?.status ?? (pendingRunId ? 'running' : 'idle'))
  const { setMessageScrollArea, setFollowingLatest, scrollViewport, beginTurnNavigation, scrollToFinalAnswer, followFinalAnswer, registerTimelineScroll } = useTimelineViewport({ selectedSessionId: selection.sessionId, history: view.history,
    activeTurn: activeRuntimeTurn(run?.turns ?? []), isActive: isRunning, pendingJump: view.pendingJump, onCancelTurnJump: view.cancelTurnJump })
  useLayoutEffect(() => {
    setFollowingLatest(true)
    scrollViewport?.scrollTo({ top: scrollViewport.scrollHeight, behavior: 'instant' })
  }, [selection, scrollViewport, setFollowingLatest])
  return <div ref={setMessageScrollArea} className="relative min-h-0 flex-1">
    <ScrollArea className="h-full"><div className="px-3 pb-6">
    {view.historyQuery.hasPreviousPage && <Button size="sm" variant="ghost" disabled={view.historyQuery.isFetchingPreviousPage} onClick={view.loadEarlier}>加载更早对话</Button>}
    <SessionTimeline sessionId={selection.sessionId} sessionCwd={cwd} history={view.history} error={view.historyError} isLoading={view.historyQuery.isPending}
      hasEarlier={view.historyQuery.hasPreviousPage} isLoadingEarlier={view.historyQuery.isFetchingPreviousPage} onLoadEarlier={view.loadEarlier}
      turnIndex={view.turnIndexQuery.data} pendingJump={view.pendingJump} jumpError={view.jumpError} onTurnJumpFinished={view.finishTurnJump}
      onRequestTurnJump={(...args) => { beginTurnNavigation(); return view.requestTurnJump(...args) }} onReadTurnPrompt={view.readTurnPrompt} navigationNotice={view.navigationNotice} onRetryNavigation={view.retryNavigation}
      turns={run?.turns} systemEvents={run?.systemEvents} runStatus={run?.status} isRunning={isRunning}
      branchDisabled={branchDisabled || isRunning} editDisabled branchAnswerLabel="从此轮后新建分支"
      onBranchAnswer={(entryId, revision) => onBranch({ kind: 'fork', mode: 'continue', entryId, revision })}
      onFinalAnswerStart={scrollToFinalAnswer} onFinalAnswerStream={followFinalAnswer}
      registerTimelineScroll={registerTimelineScroll} onRetry={view.retryHistory} scrollViewport={scrollViewport} />
    </div></ScrollArea>
  </div>
}
