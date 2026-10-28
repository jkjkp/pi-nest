import { useState, type Dispatch, type SetStateAction } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { SetURLSearchParams } from 'react-router'
import type { PiSessionInitialSettings } from '@pi-nest/contracts'
import { setDraftAttachments, type useAttachmentDraft } from './attachment-draft.js'
import type { SessionRunController } from './session-run-controller.js'
import { useWorkspaceStore } from './workspace-store.js'
import { createSession, fetchPiConfiguration, fetchSessions } from './workspace-api.js'
import type { ProjectSessionGroup } from './workspace.js'

type WorkspaceDraftOptions = {
  sessionRuns: SessionRunController
  draftProject: ProjectSessionGroup | undefined
  attachmentDraft: ReturnType<typeof useAttachmentDraft>
  refetchSessions: () => Promise<unknown>
  setSearchParams: SetURLSearchParams
  setControlFailure: (failure: { sessionId: string; message: string }) => void
  setThinkingOpen: Dispatch<SetStateAction<boolean>>
}

export function useWorkspaceDraft({ sessionRuns, draftProject, attachmentDraft, refetchSessions, setSearchParams, setControlFailure, setThinkingOpen }: WorkspaceDraftOptions) {
  const queryClient = useQueryClient()
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  const isDraft = Boolean(draftProject)
  const [draftError, setDraftError] = useState<string>()
  const [draftPrompt, setDraftPrompt] = useState('')
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [draftSettings, setDraftSettings] = useState<Record<string, PiSessionInitialSettings>>({})
  const draftCwd = draftProject?.cwd ?? ''
  const draftConfiguration = useQuery({ queryKey: ['draft-configuration', draftCwd], queryFn: () => fetchPiConfiguration(undefined, draftCwd), enabled: isDraft, retry: false })
  const draftModels = draftConfiguration.data?.models ?? []
  const draftDefaults = draftConfiguration.data?.settings.effective
  const draftSelection = draftSettings[draftCwd]
  const draftModel = draftSelection?.model ?? draftModels.find((model) => model.provider === draftDefaults?.defaultProvider && model.id === draftDefaults?.defaultModel)
  const draftLevels = draftModels.find((model) => model.provider === draftModel?.provider && model.id === draftModel?.id)?.thinkingLevels ?? []
  const requestedThinking = draftSelection?.thinkingLevel ?? draftDefaults?.defaultThinkingLevel
  const draftThinking = requestedThinking && draftLevels.includes(requestedThinking) ? requestedThinking : draftLevels[0]
  const draftSettingsStatus: 'switching' | 'loading' | 'error' | 'ready' = creatingDraft ? 'switching' : draftConfiguration.isFetching ? 'loading' : draftConfiguration.isError ? 'error' : 'ready'
  const draftSettingsError = draftConfiguration.error?.message
  const loadDraftSettings = async (refresh: boolean) => {
    const result = refresh || !draftConfiguration.data ? await draftConfiguration.refetch() : draftConfiguration
    return result.data?.models
  }

  async function submitDraft() {
    if (!draftProject?.cwd || (!draftPrompt.trim() && !attachmentDraft.items.length) || creatingDraft) return
    setCreatingDraft(true)
    setDraftError(undefined)
    try {
      const firstPrompt = draftPrompt.trim()
      const attachedItems = [...attachmentDraft.items]
      const input = attachmentDraft.submission(firstPrompt)
      const attachments = input && attachmentDraft.scope?.kind === 'draft' ? { attachmentIds: input.attachmentIds, submissionId: input.submissionId, draftId: attachmentDraft.scope.draftId } : undefined
      const selection = draftSettings[draftProject.cwd]
      if (selection && (draftConfiguration.isError || draftConfiguration.isFetching)) throw new Error('请先重新加载模型配置，再发送消息。')
      if (selection?.model && !draftModels.some((model) => model.provider === selection.model?.provider && model.id === selection.model.id)) throw new Error('所选模型已不可用，请重新选择。')
      const initialSettings = selection ? { ...selection, ...(selection.thinkingLevel !== undefined ? { thinkingLevel: draftThinking } : {}) } : undefined
      const created = await createSession(draftProject.cwd, firstPrompt, attachments, initialSettings)
      attachmentDraft.clear(attachedItems)
      sessionRuns.adopt({ historyTurnCount: 0, prompt: firstPrompt || '请查看附件。', ...(input ? { attachments: input.attachments, submissionId: input.submissionId } : {}), sessionId: created.id })
      queryClient.setQueryData<Awaited<ReturnType<typeof fetchSessions>>>(['sessions'], (current) => [created, ...(current ?? []).filter((session) => session.id !== created.id)])
      setDraftPrompt((value) => value.trim() === firstPrompt ? '' : value)
      setSearchParams({ session: created.id })
      setNavigationOpen(false)
    } catch (cause) {
      setDraftError(cause instanceof Error ? cause.message : '创建 Pi 会话失败，请重试。')
      if (cause instanceof Error && 'sessionId' in cause && typeof cause.sessionId === 'string') {
        setDraftAttachments(cause.sessionId, attachmentDraft.snapshot())
        useWorkspaceStore.getState().setDraft(cause.sessionId, draftPrompt)
        setControlFailure({ sessionId: cause.sessionId, message: cause.message })
        setSearchParams({ session: cause.sessionId })
        void refetchSessions()
      }
    } finally {
      setCreatingDraft(false)
    }
  }

  async function changeModel(provider: string, modelId: string) {
    const model = draftModels.find((candidate) => candidate.provider === provider && candidate.id === modelId)
    if (!model || creatingDraft) return false
    const level = draftThinking && model.thinkingLevels.includes(draftThinking) ? draftThinking : model.thinkingLevels[0]
    setDraftSettings((current) => ({ ...current, [draftCwd]: { model: { provider, id: modelId }, ...(level !== undefined ? { thinkingLevel: level } : {}) } }))
    return true
  }

  async function changeThinkingLevel(level: string) {
    if (!draftModel || !draftLevels.includes(level) || creatingDraft) return false
    setDraftSettings((current) => ({ ...current, [draftCwd]: { model: { provider: draftModel.provider, id: draftModel.id }, thinkingLevel: level } }))
    setThinkingOpen(false)
    return true
  }

  return {
    draftPrompt, setDraftPrompt, draftError, setDraftError, creatingDraft, submitDraft,
    draftModels, draftModel, draftLevels, draftThinking, draftSettingsStatus, draftSettingsError,
    loadDraftSettings, changeModel, changeThinkingLevel,
  }
}
