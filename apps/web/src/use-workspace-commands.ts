import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { lastCompletedAssistantText, parseComposerCommand } from './composer-commands.js'
import type { SessionRunController } from './session-run-controller.js'
import type { useWorkspaceSession } from './use-workspace-session.js'
import { useWorkspaceStore } from './workspace-store.js'

type CompactNotice = { message: string; running?: boolean; cancelling?: boolean; error?: boolean }

type Workspace = ReturnType<typeof useWorkspaceSession>
type CommandUi = { fork: (onFork: (entryId: string, revision: string) => Promise<void>) => void; rename: (onSaved: () => void) => void; statistics: () => void; settings: () => void }

export function useWorkspaceCommands(workspace: Workspace, sessionRuns: SessionRunController, ui: CommandUi) {
  const currentSession = useRef(workspace.selectedSessionId)
  const compacting = useRef(new Set<string>())
  const cancelling = useRef(new Set<string>())
  const [compactNotices, setCompactNotices] = useState<Partial<Record<string, CompactNotice>>>({})
  const pending = useRef(new Set<string>())
  const [busySessions, setBusySessions] = useState<string[]>([])
  const [notice, setNotice] = useState<CompactNotice & { sessionId: string }>()
  useLayoutEffect(() => { currentSession.current = workspace.selectedSessionId }, [workspace.selectedSessionId])
  useEffect(() => {
    if (!notice?.error) return
    // oxlint-disable-next-line react/set-state-in-effect -- Clear transient feedback when its session route is left.
    if (notice.sessionId !== workspace.selectedSessionId) { setNotice(undefined); return }
    const timer = setTimeout(() => setNotice((current) => current === notice ? undefined : current), 2000)
    return () => clearTimeout(timer)
  }, [notice, workspace.selectedSessionId])

  const compactNotice = compactNotices[workspace.selectedSessionId]
  useEffect(() => {
    if (!compactNotice || compactNotice.running) return
    const sessionId = workspace.selectedSessionId
    const timer = setTimeout(() => setCompactNotices((current) => {
      if (current[sessionId] !== compactNotice) return current
      const next = { ...current }; delete next[sessionId]; return next
    }), compactNotice.error ? 2000 : 3000)
    return () => clearTimeout(timer)
  }, [compactNotice, workspace.selectedSessionId])

  async function cancelCompact() {
    const sessionId = workspace.selectedSessionId
    if (!compacting.current.has(sessionId) || cancelling.current.has(sessionId)) return
    cancelling.current.add(sessionId)
    setCompactNotices((current) => ({ ...current, [sessionId]: { message: '正在取消压缩…', running: true, cancelling: true } }))
    try { await sessionRuns.cancelCompact(sessionId) }
    catch (cause) {
      if (compacting.current.has(sessionId)) setCompactNotices((current) => ({ ...current, [sessionId]: { message: `取消失败：${cause instanceof Error ? cause.message : '请重试'}（Esc 重试）`, running: true } }))
      cancelling.current.delete(sessionId)
    }
  }

  function submit(text: string) {
    const sessionId = workspace.selectedSessionId
    if (pending.current.has(sessionId)) return true
    const parsed = parseComposerCommand(text)
    if (!parsed) return false
    const command = parsed
    setCompactNotices((current) => {
      if (!current[sessionId]) return current
      const next = { ...current }; delete next[sessionId]; return next
    })
    function report(message: string, error = false) {
      if (currentSession.current === sessionId) setNotice({ sessionId, message, error })
    }
    function complete(message?: string) {
      if (currentSession.current !== sessionId) return
      const store = useWorkspaceStore.getState()
      if (store.drafts[sessionId] === text) store.setDraft(sessionId, '')
      setNotice(message ? { sessionId, message } : undefined)
    }
    async function execute() {
      try {
        if (workspace.isDraft || !workspace.selectedSession) throw new Error('请先进入已有会话，再执行命令。')
        if (['session', 'copy', 'settings', 'fork', 'clone', 'rename'].includes(command.name) && command.argument) throw new Error(`用法：/${command.name}（无需参数）`)
        if (['compact', 'rename', 'fork', 'clone'].includes(command.name)) {
          if (workspace.isActive || workspace.runtimeStates[sessionId]?.lifecycle === 'active') throw new Error('请等待当前任务结束后再执行此命令。')
          if (workspace.mutatingSessionId === sessionId || ['loading', 'switching'].includes(workspace.modelStatus) || ['loading', 'switching'].includes(workspace.thinkingStatus) || workspace.runtimeStates[sessionId]?.lifecycle === 'loading') throw new Error('正在处理会话操作，请稍后重试。')
        }
        pending.current.add(sessionId)
        setBusySessions([...pending.current])
        report(`正在执行 /${command.name}…`)
        switch (command.name) {
          case 'compact': {
            compacting.current.add(sessionId)
            setNotice(undefined)
            const store = useWorkspaceStore.getState()
            if (store.drafts[sessionId] === text) store.setDraft(sessionId, '')
            setCompactNotices((current) => ({ ...current, [sessionId]: { message: '压缩上下文… (Esc 取消)', running: true } }))
            const completed = await sessionRuns.compact(sessionId, command.argument || undefined)
            const current = useWorkspaceStore.getState()
            if (completed !== false && current.drafts[sessionId] === text) current.setDraft(sessionId, '')
            setCompactNotices((current) => ({ ...current, [sessionId]: { message: completed === false ? '已取消上下文压缩' : '上下文压缩完成' } }))
            break
          }
          case 'rename':
            ui.rename(() => report('会话已重命名'))
            complete()
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
          case 'fork':
            ui.fork(async (entryId, revision) => {
              const result = await workspace.createBranch({ kind: 'fork', entryId, revision })
              if (currentSession.current !== sessionId) return
              complete('分支会话已创建')
              workspace.selectSession(result.session.id)
            })
            report('请选择从哪条用户消息开始分叉')
            break
          case 'clone': {
            const result = await workspace.createBranch({ kind: 'clone' })
            if (currentSession.current !== sessionId) return
            complete()
            workspace.selectSession(result.session.id)
            break
          }
          case 'settings':
            complete('正在打开设置')
            ui.settings()
            break
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '命令执行失败，请重试。'
        if (compacting.current.has(sessionId)) {
          const store = useWorkspaceStore.getState()
          if (!store.drafts[sessionId]) store.setDraft(sessionId, text)
          setCompactNotices((current) => ({ ...current, [sessionId]: { message, error: true } }))
        } else report(message, true)
      } finally {
        compacting.current.delete(sessionId)
        cancelling.current.delete(sessionId)
        pending.current.delete(sessionId); setBusySessions([...pending.current])
      }
    }
    void execute()
    return true
  }

  return { submit, cancelCompact, busy: busySessions.includes(workspace.selectedSessionId), notice: compactNotice ?? (notice?.sessionId === workspace.selectedSessionId ? notice : undefined) }
}
