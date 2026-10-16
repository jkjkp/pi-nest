import { useLayoutEffect, useRef, useState } from 'react'
import { lastCompletedAssistantText, parseComposerCommand } from './composer-commands.js'
import type { SessionRunController } from './session-run-controller.js'
import type { useWorkspaceSession } from './use-workspace-session.js'
import { useWorkspaceStore } from './workspace-store.js'

type Workspace = ReturnType<typeof useWorkspaceSession>
type CommandUi = { model: () => void; rename: (onSaved: () => void) => void; statistics: () => void; settings: () => void }

export function useWorkspaceCommands(workspace: Workspace, sessionRuns: SessionRunController, ui: CommandUi) {
  const currentSession = useRef(workspace.selectedSessionId)
  const pending = useRef(new Set<string>())
  const [busySessions, setBusySessions] = useState<string[]>([])
  const [notice, setNotice] = useState<{ sessionId: string; message: string; error?: boolean }>()
  useLayoutEffect(() => { currentSession.current = workspace.selectedSessionId }, [workspace.selectedSessionId])

  function submit(text: string) {
    const sessionId = workspace.selectedSessionId
    if (pending.current.has(sessionId)) return true
    const parsed = parseComposerCommand(text)
    if (!parsed || parsed.name === 'thinking') return false
    const command = parsed
    function report(message: string, error = false) {
      if (currentSession.current === sessionId) setNotice({ sessionId, message, error })
    }
    function complete(message: string) {
      if (currentSession.current !== sessionId) return
      const store = useWorkspaceStore.getState()
      if (store.drafts[sessionId] === text) store.setDraft(sessionId, '')
      report(message)
    }
    async function execute() {
      try {
        if (workspace.isDraft || !workspace.selectedSession) throw new Error('请先进入已有会话，再执行命令。')
        if (['session', 'copy', 'settings'].includes(command.name) && command.argument) throw new Error(`用法：/${command.name}（无需参数）`)
        if (['model', 'compact', 'name'].includes(command.name)) {
          if (workspace.isActive || workspace.runtimeStates[sessionId]?.lifecycle === 'active') throw new Error('请等待当前任务结束后再执行此命令。')
          if (workspace.mutatingSessionId === sessionId || ['loading', 'switching'].includes(workspace.modelStatus) || ['loading', 'switching'].includes(workspace.thinkingStatus) || workspace.runtimeStates[sessionId]?.lifecycle === 'loading') throw new Error('正在处理会话操作，请稍后重试。')
        }
        pending.current.add(sessionId)
        setBusySessions([...pending.current])
        report(`正在执行 /${command.name}…`)
        switch (command.name) {
          case 'model': {
            if (!command.argument) { ui.model(); complete('已打开模型选择器'); break }
            const models = await workspace.openModels()
            if (currentSession.current !== sessionId) return
            if (!models) throw new Error('模型列表读取失败，请重试。')
            const model = models.find((model) => `${model.provider}/${model.id}` === command.argument)
            if (!model) throw new Error('未找到指定模型，请使用 /model 选择，或填写完整的 provider/modelId。')
            if (!await workspace.changeModel(model.provider, model.id)) throw new Error('模型切换失败，请重试。')
            complete(`已切换模型：${model.provider}/${model.id}`)
            break
          }
          case 'compact':
            await sessionRuns.compact(sessionId, command.argument || undefined)
            complete('上下文压缩完成')
            break
          case 'name':
            if (!command.argument) { ui.rename(() => complete('会话已重命名')); report('请在对话框中设置会话名称'); break }
            if (command.argument.length > 120) throw new Error('会话名称不能超过 120 个字符。')
            await workspace.handleRename(sessionId, command.argument)
            complete('会话已重命名')
            break
          case 'session':
            ui.statistics()
            void sessionRuns.getSessionStatistics(sessionId)
            complete('已打开会话用量与上下文')
            break
          case 'copy': {
            if (workspace.historyQuery.isPending || workspace.historyQuery.isError) throw new Error('会话历史尚未就绪，请稍后重试。')
            const text = lastCompletedAssistantText(workspace.history?.entries ?? [], workspace.currentRun?.turns ?? [])
            if (!text) throw new Error('当前会话没有可复制的已完成助手消息。')
            if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入。')
            try { await navigator.clipboard.writeText(text) }
            catch { throw new Error('复制失败，请检查浏览器剪贴板权限后重试。') }
            complete('已复制助手消息')
            break
          }
          case 'settings':
            complete('正在打开设置')
            ui.settings()
            break
        }
      } catch (cause) { report(cause instanceof Error ? cause.message : '命令执行失败，请重试。', true) }
      finally { pending.current.delete(sessionId); setBusySessions([...pending.current]) }
    }
    void execute()
    return true
  }

  return { submit, busy: busySessions.includes(workspace.selectedSessionId), notice: notice?.sessionId === workspace.selectedSessionId ? notice : undefined }
}
