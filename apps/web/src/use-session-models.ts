import { useEffect, useRef, useState, type RefObject } from 'react'
import type { PiRuntimeModel, PiRuntimeState, PiSessionSummary } from '@pi-nest/contracts'
import type { SessionRunController } from './session-run-controller.js'
import { useWorkspaceStore } from './workspace-store.js'

type SessionModelsOptions = {
  sessionRuns: SessionRunController
  selectedSessionId: string
  selectedSession: PiSessionSummary | undefined
  selectedSessionIdRef: RefObject<string>
  controlKey: string
  isActive: boolean
}

export function useSessionModels({ sessionRuns, selectedSessionId, selectedSession, selectedSessionIdRef, controlKey, isActive }: SessionModelsOptions) {
  const runtimeDetails = useWorkspaceStore((state) => state.runtimeDetails)
  const runtimeStates = useWorkspaceStore((state) => state.runtimeStates)
  const watchStates = useWorkspaceStore((state) => state.watchStates)
  const [models, setModels] = useState<PiRuntimeModel[]>([])
  const [modelStatus, setModelStatus] = useState<'unloaded' | 'loading' | 'ready' | 'error' | 'switching'>('unloaded')
  const [modelError, setModelError] = useState<string>()
  const modelCache = useRef(new Map<string, { details: PiRuntimeState; models: PiRuntimeModel[] }>())
  const modelOperation = useRef<{ sessionId: string } | undefined>(undefined)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [thinkingStatus, setThinkingStatus] = useState<'unloaded' | 'loading' | 'ready' | 'error' | 'switching'>('unloaded')
  const [thinkingError, setThinkingError] = useState<string>()
  const [thinkingFailure, setThinkingFailure] = useState(0)
  const thinkingCache = useRef(new Map<string, { model: string; levels: string[] }>())
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([])
  const [controlSessionId, setControlSessionId] = useState(controlKey)
  if (controlSessionId !== controlKey) {
    setControlSessionId(controlKey)
    setModels([])
    setModelStatus('unloaded')
    setModelError(undefined)
    setThinkingLevels([])
    setThinkingStatus('unloaded')
    setThinkingError(undefined)
    setThinkingFailure(0)
    setThinkingOpen(false)
  }
  const currentModel = runtimeDetails[selectedSessionId]?.model
  const modelKey = `${currentModel?.provider}/${currentModel?.id}`
  const [thinkingModelKey, setThinkingModelKey] = useState(modelKey)
  if (thinkingModelKey !== modelKey) {
    setThinkingModelKey(modelKey)
    setThinkingLevels([])
    setThinkingStatus('unloaded')
    setThinkingError(undefined)
  }
  const modelName = models.find((model) => model.id === currentModel?.id && model.provider === currentModel?.provider)?.name ?? currentModel?.id
  const modelLabel = currentModel?.id && currentModel.provider ? (modelName ?? currentModel.id) : '选择模型'

  useEffect(() => {
    if (!selectedSession || watchStates[selectedSessionId] !== 'ready' || modelOperation.current?.sessionId === selectedSessionId) return
    if (runtimeDetails[selectedSessionId]?.model) return
    if (isActive || runtimeStates[selectedSessionId]?.lifecycle === 'active' || (modelStatus !== 'unloaded' && !(modelStatus === 'ready' && runtimeStates[selectedSessionId]?.lifecycle === 'notLoaded'))) return
    const operation = { sessionId: selectedSessionId }
    modelOperation.current = operation
    // oxlint-disable-next-line react/set-state-in-effect -- Initialize the external Pi runtime when this session becomes ready.
    setModelStatus('loading')
    setModelError(undefined)
    void (async () => {
      try {
        await sessionRuns.resumeRuntime(selectedSessionId)
        const store = useWorkspaceStore.getState()
        if (!store.runtimeDetails[selectedSessionId] && store.runtimeStates[selectedSessionId]?.lifecycle !== 'active') await sessionRuns.getRuntimeState(selectedSessionId)
        if (selectedSessionIdRef.current === selectedSessionId && modelOperation.current === operation) setModelStatus('ready')
      } catch (cause) {
        if (selectedSessionIdRef.current !== selectedSessionId || modelOperation.current !== operation) return
        if (useWorkspaceStore.getState().runtimeStates[selectedSessionId]?.lifecycle === 'active') setModelStatus('ready')
        else {
          setModelError(cause instanceof Error ? cause.message : '无法读取模型，请重试。')
          setModelStatus('error')
        }
      } finally {
        if (modelOperation.current === operation) modelOperation.current = undefined
      }
    })()
  }, [selectedSession, selectedSessionId, selectedSessionIdRef, watchStates, runtimeDetails, runtimeStates, isActive, modelStatus, sessionRuns])

  async function openModels(refresh = false) {
    if (!selectedSessionId || modelOperation.current?.sessionId === selectedSessionId) return
    const cached = modelCache.current.get(selectedSessionId)
    if (!refresh && cached && cached.details === useWorkspaceStore.getState().runtimeDetails[selectedSessionId]) {
      setModels(cached.models)
      setModelStatus('ready')
      setModelError(undefined)
      return cached.models
    }
    if (isActive) return
    const operation = { sessionId: selectedSessionId }
    modelOperation.current = operation
    setModelStatus('loading')
    setModelError(undefined)
    try {
      await sessionRuns.resumeRuntime(selectedSessionId)
      await sessionRuns.getRuntimeState(selectedSessionId)
      const availableModels = await sessionRuns.getAvailableModels(selectedSessionId)
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return
      const details = useWorkspaceStore.getState().runtimeDetails[selectedSessionId]
      if (details) modelCache.current.set(selectedSessionId, { details, models: availableModels })
      setModels(availableModels)
      setModelStatus('ready')
      return availableModels
    } catch (cause) {
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return
      setModelError(cause instanceof Error ? cause.message : '无法读取模型，请重试。')
      setModelStatus('error')
    } finally {
      if (modelOperation.current === operation) modelOperation.current = undefined
    }
  }

  async function openThinking(refresh = false) {
    if (!selectedSessionId || modelOperation.current?.sessionId === selectedSessionId) return
    const model = `${currentModel?.provider}/${currentModel?.id}`
    const cached = thinkingCache.current.get(selectedSessionId)
    if (!refresh && cached?.model === model) { setThinkingLevels(cached.levels); setThinkingStatus('ready'); return }
    if (isActive) return
    const operation = { sessionId: selectedSessionId }
    modelOperation.current = operation
    setThinkingStatus('loading')
    setThinkingError(undefined)
    try {
      await sessionRuns.resumeRuntime(selectedSessionId)
      await sessionRuns.getRuntimeState(selectedSessionId)
      const levels = await sessionRuns.getAvailableThinkingLevels(selectedSessionId)
      const actualModel = useWorkspaceStore.getState().runtimeDetails[selectedSessionId]?.model
      thinkingCache.current.set(selectedSessionId, { model: `${actualModel?.provider}/${actualModel?.id}`, levels })
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return
      setThinkingLevels(levels)
      setThinkingStatus('ready')
    } catch (cause) {
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return
      setThinkingError(cause instanceof Error ? cause.message : '无法读取思考等级，请重试。')
      setThinkingStatus('error')
    } finally { if (modelOperation.current === operation) modelOperation.current = undefined }
  }

  async function changeModel(provider: string, modelId: string) {
    if (!selectedSessionId || isActive || modelOperation.current?.sessionId === selectedSessionId) return false
    const operation = { sessionId: selectedSessionId }
    modelOperation.current = operation
    setModelStatus('switching')
    setModelError(undefined)
    try {
      await sessionRuns.setModel(selectedSessionId, provider, modelId)
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return false
      const details = useWorkspaceStore.getState().runtimeDetails[selectedSessionId]
      const cached = modelCache.current.get(selectedSessionId)
      if (details && cached) modelCache.current.set(selectedSessionId, { ...cached, details })
      thinkingCache.current.delete(selectedSessionId)
      setThinkingLevels([])
      setThinkingStatus('unloaded')
      setThinkingError(undefined)
      setModelStatus('ready')
      return true
    } catch (cause) {
      if (selectedSessionId === selectedSessionIdRef.current && modelOperation.current === operation) {
        setModelError(cause instanceof Error ? cause.message : '模型切换失败，请重试。')
        setModelStatus('ready')
      }
      return false
    } finally {
      if (modelOperation.current === operation) modelOperation.current = undefined
    }
  }

  async function changeThinkingLevel(level: string) {
    if (!selectedSessionId || isActive || modelOperation.current?.sessionId === selectedSessionId) return false
    const operation = { sessionId: selectedSessionId }
    modelOperation.current = operation
    setThinkingStatus('switching')
    setThinkingError(undefined)
    try {
      await sessionRuns.resumeRuntime(selectedSessionId)
      const levels = await sessionRuns.getAvailableThinkingLevels(selectedSessionId)
      const model = useWorkspaceStore.getState().runtimeDetails[selectedSessionId]?.model
      thinkingCache.current.set(selectedSessionId, { model: `${model?.provider}/${model?.id}`, levels })
      if (selectedSessionId === selectedSessionIdRef.current && modelOperation.current === operation) setThinkingLevels(levels)
      if (!levels.includes(level)) throw new Error(`未知思考等级“${level}”。可用等级：${levels.join('、') || '无'}`)
      await sessionRuns.setThinkingLevel(selectedSessionId, level)
      if (selectedSessionId !== selectedSessionIdRef.current || modelOperation.current !== operation) return false
      const effective = useWorkspaceStore.getState().runtimeDetails[selectedSessionId]?.thinkingLevel
      if (effective === undefined) throw new Error('Pi 未返回实际思考等级，请重试确认。')
      setThinkingStatus('ready')
      setThinkingOpen(false)
      return true
    } catch (cause) {
      if (selectedSessionId === selectedSessionIdRef.current && modelOperation.current === operation) {
        console.error('Pi thinking change failed', cause)
        setThinkingFailure((failure) => failure + 1)
        setThinkingStatus('ready')
      }
      return false
    } finally { if (modelOperation.current === operation) modelOperation.current = undefined }
  }

  return {
    models, modelStatus, modelError, modelOperation, currentModel, modelLabel,
    thinkingOpen, setThinkingOpen, thinkingStatus, thinkingError, thinkingFailure, thinkingLevels,
    openModels, openThinking, changeModel, changeThinkingLevel,
  }
}
