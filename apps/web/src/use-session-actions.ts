import { useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SetURLSearchParams } from 'react-router'
import type { PiSessionBranchRequest, PiSessionSummary } from '@pi-nest/contracts'
import { setDraftAttachments } from './attachment-draft.js'
import { sessionHistoryQueryKey } from './history.js'
import type { SessionRunController } from './session-run-controller.js'
import { isRunActive } from './session-run-model.js'
import { useWorkspaceStore } from './workspace-store.js'
import { branchSession, deleteSession, fetchSessions, renameSession } from './workspace-api.js'
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

  async function createBranch(request: PiSessionBranchRequest, sessionId = selectedSessionId) {
    const store = useWorkspaceStore.getState()
    const status = store.runs[sessionId]?.status ?? (store.sessionNotifications[sessionId]?.pendingRunId ? 'running' : 'idle')
    if (!sessions.some((session) => session.id === sessionId) || isRunActive(status) || modelOperation.current?.sessionId === sessionId || mutatingSessionId !== undefined || branchingSession.current !== undefined) throw new Error('请等待当前会话操作结束后再创建分支。')
    branchingSession.current = sessionId
    setMutatingSessionId(sessionId)
    try {
      const result = await branchSession(sessionId, request)
      queryClient.setQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'], (current) => [result.session, ...(current ?? []).filter((session) => session.id !== result.session.id)])
      useWorkspaceStore.getState().setDraft(result.session.id, result.draft)
      if (result.attachments?.length) setDraftAttachments(result.session.id, result.attachments)
      return result
    } finally { branchingSession.current = undefined; setMutatingSessionId(undefined) }
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

  return { mutatingSessionId, createBranch, handleRename, handleDelete }
}
