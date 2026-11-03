import { useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SetURLSearchParams } from 'react-router'
import type { PiSessionBranchRequest, PiSessionBranchResponse, PiSessionSummary } from '@pi-nest/contracts'
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

  function applyBranchResult(result: PiSessionBranchResponse) {
    queryClient.setQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'], (current) => [result.session, ...(current ?? []).filter((session) => session.id !== result.session.id)])
    void queryClient.invalidateQueries({ queryKey: ['session-graph'] })
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
      applyBranchResult(result)
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
      applyBranchResult(result)
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
      await refetchSessions()
    } finally {
      setMutatingSessionId(undefined)
    }
  }

  async function handleDelete(sessionId: string) {
    setMutatingSessionId(sessionId)
    try {
      await deleteSession(sessionId)
      sessionRuns.removeSessionNotification(sessionId)
      useWorkspaceStore.getState().clearFilePreview(sessionId)
      queryClient.removeQueries({ queryKey: ['session-file-preview', sessionId] })
      queryClient.setQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'], (current) => current?.filter((session) => session.id !== sessionId))
      if (selectedSessionIdRef.current === sessionId) {
        const next = projects.flatMap((project) => project.sessions).find((session) => session.id !== sessionId)
        if (!next) sessionRuns.releaseForeground()
        setSearchParams(next ? { session: next.id } : {})
      }
      queryClient.removeQueries({ queryKey: sessionHistoryQueryKey(sessionId) })
      queryClient.removeQueries({ queryKey: ['session-history-page', sessionId] })
      await refetchSessions()
    } finally {
      setMutatingSessionId(undefined)
    }
  }

  return { mutatingSessionId, createBranch, checkBranch, handleRename, handleDelete }
}
