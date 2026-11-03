import { useEffect } from 'react'
import { useWorkspaceStore } from './workspace-store.js'

export function useSessionRead(sessionId: string, ready: boolean, onRead: (sessionId: string, runId: string) => void) {
  const notification = useWorkspaceStore((state) => state.sessionNotifications[sessionId])
  const completedRunId = notification?.completedRunId
  const readRunId = notification?.readRunId
  const pendingRunId = notification?.pendingRunId
  useEffect(() => {
    if (!ready || !completedRunId || completedRunId === readRunId || pendingRunId) return
    let frame: number | undefined
    const markRead = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (document.visibilityState !== 'visible') return
      frame = requestAnimationFrame(() => {
        if (document.visibilityState === 'visible') onRead(sessionId, completedRunId)
      })
    }
    markRead()
    document.addEventListener('visibilitychange', markRead)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', markRead)
    }
  }, [sessionId, ready, completedRunId, readRunId, pendingRunId, onRead])
}
