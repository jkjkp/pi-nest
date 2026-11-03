import { useRef, useState, type RefObject } from 'react'
import { useQueryClient, type Query } from '@tanstack/react-query'
import type { SetURLSearchParams } from 'react-router'
import type { PiSessionBranchRequest, PiSessionBranchResponse, PiSessionGraph, PiSessionSummary } from '@pi-nest/contracts'
import { graphFamily } from '@pi-nest/contracts/session-graph'
import { setDraftAttachments, useAttachmentStore } from './attachment-draft.js'
import { sessionHistoryQueryKey } from './history.js'
import type { SessionRunController } from './session-run-controller.js'
import { isRunActive } from './session-run-model.js'
import { useWorkspaceStore } from './workspace-store.js'
import { branchSession, fetchBranchOperation, deleteSession, fetchSessions, renameSession } from './workspace-api.js'
import type { ProjectSessionGroup } from './workspace.js'

type SessionActionsOptions = {
  sessionRuns: SessionRunController
  selectedSessionId: string
  selectedSessionIdRef: RefObject<string>
  modelOperation: RefObject<{ sessionId: string } | undefined>
  sessions: PiSessionSummary[]
  projects: ProjectSessionGroup[]
  refetchSessions: () => Promise<unknown>
  setSearchParams: SetURLSearchParams
}

export function useSessionActions({ sessionRuns, selectedSessionId, selectedSessionIdRef, modelOperation, sessions, projects, refetchSessions, setSearchParams }: SessionActionsOptions) {
  const queryClient = useQueryClient()
  const branchingSession = useRef<string | undefined>(undefined)
  const [mutatingSessionId, setMutatingSessionId] = useState<string>()

  function relatedGraphs(sessionId: string) {
    const family = graphFamily(queryClient.getQueryData<PiSessionSummary[]>(['sessions']) ?? sessions, sessionId)
    return { queryKey: ['session-graph'], predicate: (query: Query) => family.some((session) => session.id === query.queryKey[1]) || ((query.state.data as PiSessionGraph | undefined)?.sessions.some((session) => session.id === sessionId) ?? false) }
  }

  async function applyBranchResult(result: PiSessionBranchResponse, sourceId: string) {
    queryClient.setQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'], (current) => [result.session, ...(current ?? []).filter((session) => session.id !== result.session.id)])
    const related = relatedGraphs(sourceId)
    await queryClient.cancelQueries(related)
    const graphs = queryClient.getQueriesData<PiSessionGraph>(related)
    const source = graphs.find(([, graph]) => graph)?.[1] ?? { sessions: queryClient.getQueryData<PiSessionSummary[]>(['sessions']) ?? [], branchStorage: useWorkspaceStore.getState().branchStorage }
    for (const [key, graph] of graphs) {
      const current = graph ?? source
      queryClient.setQueryData(key, { ...current, sessions: graphFamily([...current.sessions.filter((session) => session.id !== result.session.id), result.session], key[1] as string) })
    }
    queryClient.setQueryData(['session-graph', result.session.id], { ...source, sessions: graphFamily([...source.sessions.filter((session) => session.id !== result.session.id), result.session], result.session.id) })
    // The destination refetches on selection; fetching the source here would duplicate that read.
    void queryClient.invalidateQueries({ ...related, refetchType: 'none' })
    const store = useWorkspaceStore.getState()
    if (!result.draftRecoveryRequired && !store.drafts[result.session.id] && !useAttachmentStore.getState().drafts[result.session.id]?.length) {
      store.setDraft(result.session.id, result.draft)
      if (result.attachments?.length) setDraftAttachments(result.session.id, result.attachments)
    }
  }

  async function createBranch(request: PiSessionBranchRequest, sessionId = selectedSessionId) {
    const store = useWorkspaceStore.getState()
    const status = store.runs[sessionId]?.status ?? (store.sessionNotifications[sessionId]?.pendingRunId ? 'running' : 'idle')
    if (!sessions.some((session) => session.id === sessionId) || isRunActive(status) || modelOperation.current?.sessionId === sessionId || mutatingSessionId !== undefined || branchingSession.current !== undefined) throw new Error('请等待当前会话操作结束后再创建分支。')
    branchingSession.current = sessionId
    setMutatingSessionId(sessionId)
    try {
      if (!store.branchStorage.available) throw new Error('关系存储不可用，无法创建新分支。')
      if (store.branchOperations[sessionId]) throw new Error('已有分支创建结果待确认，请先查询结果。')
      const operationId = request.operationId ?? crypto.randomUUID()
      store.setBranchOperation(sessionId, { operationId, request })
      let result
      try { result = await branchSession(sessionId, { ...request, operationId }) }
      catch (cause) { if (!(cause as { uncertain?: boolean }).uncertain) store.setBranchOperation(sessionId); throw cause }
      store.setBranchOperation(sessionId)
      await applyBranchResult(result, sessionId)
      return result
    } finally { branchingSession.current = undefined; setMutatingSessionId(undefined) }
  }

  async function checkBranch(sessionId = selectedSessionId) {
    const store = useWorkspaceStore.getState()
    const saved = store.branchOperations[sessionId]
    if (!saved) return
    const operation = await fetchBranchOperation(sessionId, saved.operationId)
    if (operation.result) {
      const result = operation.result
      await applyBranchResult(result, sessionId)
      store.setBranchOperation(sessionId)
      return result
    }
    if (operation.state === 'failed') store.setBranchOperation(sessionId)
    throw new Error(operation.state === 'attention' ? '分支文件需检查，已保留；请勿重复创建。' : operation.state === 'failed' ? '分支未创建，可以重新操作。' : '分支待恢复；请在任务结束后重启服务，再查询结果。')
  }

  async function handleRename(sessionId: string, name: string) {
    setMutatingSessionId(sessionId)
    try {
      await renameSession(sessionId, name)
      void queryClient.invalidateQueries({ queryKey: ['session-graph'] })
      await refetchSessions()
    } finally {
      setMutatingSessionId(undefined)
    }
  }

  async function handleDelete(sessionId: string) {
    setMutatingSessionId(sessionId)
    try {
      await deleteSession(sessionId)
      const related = relatedGraphs(sessionId)
      await queryClient.cancelQueries(related)
      const graphs = queryClient.getQueriesData<PiSessionGraph>(related)
      for (const [key, graph] of graphs) if (key[1] !== sessionId) {
        const current = graph ?? { sessions: queryClient.getQueryData<PiSessionSummary[]>(['sessions']) ?? sessions, branchStorage: useWorkspaceStore.getState().branchStorage }
        queryClient.setQueryData(key, { ...current, sessions: graphFamily(current.sessions.filter((session) => session.id !== sessionId), key[1] as string) })
      }
      queryClient.removeQueries({ queryKey: ['session-graph', sessionId], exact: true })
      sessionRuns.removeSessionNotification(sessionId)
      useWorkspaceStore.getState().clearFilePreview(sessionId)
      queryClient.removeQueries({ queryKey: ['session-file-preview', sessionId] })
      queryClient.setQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'], (current) => current?.filter((session) => session.id !== sessionId))
      if (selectedSessionIdRef.current === sessionId) {
        const remaining = projects.flatMap((project) => project.sessions).filter((session) => session.id !== sessionId)
        const deleted = sessions.find((session) => session.id === sessionId)
        const family = graphFamily(sessions, sessionId)
        const next = remaining.find((session) => session.id === deleted?.parentSessionId && family.some((member) => member.id === session.id))
          ?? remaining.find((session) => family.some((member) => member.id === session.id))
          ?? remaining.find((session) => session.cwd === deleted?.cwd)
          ?? remaining[0]
        if (next && !queryClient.getQueryData(['session-graph', next.id])) queryClient.setQueryData(['session-graph', next.id], { sessions: graphFamily(remaining, next.id), branchStorage: useWorkspaceStore.getState().branchStorage })
        if (next) void queryClient.invalidateQueries({ queryKey: ['session-graph', next.id], exact: true, refetchType: 'none' })
        if (!next) sessionRuns.releaseForeground()
        setSearchParams(next ? { session: next.id } : {})
      }
      void queryClient.invalidateQueries({ queryKey: ['session-graph'], predicate: (query) => graphs.some(([key]) => key[1] === query.queryKey[1]) && query.queryKey[1] !== sessionId })
      queryClient.removeQueries({ queryKey: sessionHistoryQueryKey(sessionId) })
      queryClient.removeQueries({ queryKey: ['session-history-page', sessionId] })
      await refetchSessions()
    } finally {
      setMutatingSessionId(undefined)
    }
  }

  return { mutatingSessionId, createBranch, checkBranch, handleRename, handleDelete }
}
