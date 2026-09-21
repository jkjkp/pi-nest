import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router'

import { readSse } from './read-sse.js'

type PiSessionSummary = {
  cwd?: string
  id: string
  updatedAt?: string
}

type PromptStatus = 'idle' | 'running' | 'aborting' | 'aborted' | 'complete' | 'error'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Workspace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function Workspace() {
  const requestController = useRef<AbortController | undefined>(undefined)
  const [error, setError] = useState<string>()
  const [model, setModel] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [responseText, setResponseText] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [sessions, setSessions] = useState<PiSessionSummary[]>([])
  const [status, setStatus] = useState<PromptStatus>('idle')

  useEffect(() => {
    const controller = new AbortController()

    async function loadSessions() {
      try {
        const response = await fetch('/api/sessions', { signal: controller.signal })
        if (!response.ok) throw new Error(`Failed to load sessions: ${response.status}`)

        const body = (await response.json()) as { sessions?: PiSessionSummary[] }
        if (!Array.isArray(body.sessions)) throw new Error('Invalid session list response')

        setSessions(body.sessions)
        setSelectedSessionId((current) => current || body.sessions?.[0]?.id || '')
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(cause instanceof Error ? cause.message : 'Failed to load sessions')
        }
      }
    }

    void loadSessions()
    return () => {
      controller.abort()
      requestController.current?.abort()
    }
  }, [])

  async function submitPrompt(event: FormEvent) {
    event.preventDefault()
    if (!selectedSessionId || status === 'running' || status === 'aborting' || prompt.trim().length === 0) {
      return
    }

    const controller = new AbortController()
    requestController.current = controller
    setError(undefined)
    setModel(undefined)
    setResponseText('')
    setStatus('running')
    let terminalEvent = false

    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(selectedSessionId)}/prompts`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt }),
          signal: controller.signal,
        },
      )

      await readSse(response, ({ data, event: eventName }) => {
        const payload = JSON.parse(data) as {
          delta?: string
          message?: string
          model?: { provider: string; id: string }
          stopReason?: string
        }

        if (eventName === 'text_delta' && typeof payload.delta === 'string') {
          setResponseText((current) => current + payload.delta)
        }
        if (eventName === 'complete') {
          terminalEvent = true
          setModel(payload.model && `${payload.model.provider}/${payload.model.id}`)
          setStatus(payload.stopReason === 'aborted' ? 'aborted' : 'complete')
        }
        if (eventName === 'error') {
          terminalEvent = true
          throw new Error(payload.message ?? 'Pi session prompt failed')
        }
      })

      if (!terminalEvent) throw new Error('Pi session stream ended without a result')
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : 'Pi session prompt failed')
        setStatus('error')
      }
    } finally {
      if (requestController.current === controller) requestController.current = undefined
    }
  }

  async function abortPrompt() {
    if (!selectedSessionId || status !== 'running') return

    setError(undefined)
    setStatus('aborting')

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/abort`, {
        method: 'POST',
      })
      if (response.status !== 202) throw new Error('Pi session could not be stopped')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pi session could not be stopped')
      setStatus('running')
    }
  }

  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
  const isActive = status === 'running' || status === 'aborting'

  return (
    <main>
      <section className="workspace">
        <header>
          <p className="eyebrow">Pi Nest</p>
          <h1>Native session stream</h1>
          <p className="subtitle">Continue an existing Pi session through the local SDK.</p>
        </header>

        <form onSubmit={(event) => void submitPrompt(event)}>
          <label htmlFor="session">Session</label>
          <select
            id="session"
            value={selectedSessionId}
            onChange={(event) => setSelectedSessionId(event.target.value)}
            disabled={isActive}
          >
            {sessions.length === 0 && <option value="">No sessions found</option>}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.id} · {session.cwd ?? 'unknown cwd'}
              </option>
            ))}
          </select>

          {selectedSession && (
            <p className="session-meta">
              {selectedSession.cwd ?? 'Unknown cwd'}
              {selectedSession.updatedAt
                ? ` · Updated ${new Date(selectedSession.updatedAt).toLocaleString()}`
                : ''}
            </p>
          )}

          <label htmlFor="prompt">Prompt</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={20_000}
            rows={6}
            disabled={isActive}
            placeholder="Send a prompt to the selected native Pi session"
          />

          <button
            type="submit"
            disabled={!selectedSessionId || prompt.trim().length === 0 || isActive}
          >
            {isActive ? 'Streaming…' : 'Send prompt'}
          </button>
          {status === 'running' && (
            <button className="abort" type="button" onClick={() => void abortPrompt()}>
              Stop response
            </button>
          )}
          {status === 'aborting' && <p className="session-meta">Stopping response…</p>}
        </form>

        <section className="result" aria-busy={isActive}>
          <div className="result-heading">
            <h2>Response</h2>
            <span data-status={status}>{status}</span>
          </div>
          <pre aria-live="polite">{responseText || 'Text deltas will appear here.'}</pre>
          {model && <p className="model">Model: {model}</p>}
          {error && <p className="error">{error}</p>}
        </section>
      </section>
    </main>
  )
}

export default App
