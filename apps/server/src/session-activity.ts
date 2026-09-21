export function createSessionActivity() {
  const activePrompts = new Map<string, AbortController>()
  const activeMutations = new Map<string, symbol>()

  function isBusy(sessionId: string) {
    return activePrompts.has(sessionId) || activeMutations.has(sessionId)
  }

  return {
    abortPrompt: (sessionId: string) => {
      const controller = activePrompts.get(sessionId)
      if (!controller) return false

      controller.abort()
      return true
    },
    beginMutation: (sessionId: string) => {
      if (isBusy(sessionId)) return undefined

      const token = Symbol(sessionId)
      activeMutations.set(sessionId, token)
      return () => {
        if (activeMutations.get(sessionId) === token) activeMutations.delete(sessionId)
      }
    },
    beginPrompt: (sessionId: string) => {
      if (isBusy(sessionId)) return undefined

      const controller = new AbortController()
      activePrompts.set(sessionId, controller)
      return controller
    },
    finishPrompt: (sessionId: string, controller: AbortController) => {
      if (activePrompts.get(sessionId) === controller) activePrompts.delete(sessionId)
    },
    isPromptActive: (sessionId: string) => activePrompts.has(sessionId),
  }
}
