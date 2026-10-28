export type RuntimeBootstrap = { runtimeId: string; token: string; websocketPath: string }

function waitForBootstrap(promise: Promise<RuntimeBootstrap>, signal?: AbortSignal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<RuntimeBootstrap>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (cause) => { signal.removeEventListener('abort', abort); reject(cause) },
    )
  })
}

export function createRuntimeBootstrap(fetchFn: typeof fetch = (...args) => fetch(...args)) {
  let cached: RuntimeBootstrap | undefined
  let pending: Promise<RuntimeBootstrap> | undefined

  function get(signal?: AbortSignal): Promise<RuntimeBootstrap> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (cached) return waitForBootstrap(Promise.resolve(cached), signal)
    // Refresh never replaces an in-flight bootstrap, so an older response cannot overwrite a newer one.
    pending ??= (async () => {
      const response = await fetchFn('/api/runtime/bootstrap', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error('无法验证访问权限')
      const value = await response.json() as Partial<RuntimeBootstrap> | null
      if (!value || typeof value.runtimeId !== 'string' || !value.runtimeId || typeof value.token !== 'string' || !value.token || typeof value.websocketPath !== 'string' || !value.websocketPath) throw new Error('访问凭据返回数据无效')
      cached = { runtimeId: value.runtimeId, token: value.token, websocketPath: value.websocketPath }
      return cached
    })().finally(() => { pending = undefined })
    return waitForBootstrap(pending, signal)
  }

  function invalidate(used: RuntimeBootstrap) {
    if (cached === used) cached = undefined
  }

  function refresh(used?: RuntimeBootstrap, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (used) invalidate(used)
    else cached = undefined
    return get(signal)
  }

  return { get, refresh, invalidate }
}

export const runtimeBootstrap = createRuntimeBootstrap()
