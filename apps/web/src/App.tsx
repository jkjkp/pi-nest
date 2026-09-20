import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Workspace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function Workspace() {
  const [serverStatus, setServerStatus] = useState('checking')

  useEffect(() => {
    const controller = new AbortController()

    async function checkServer() {
      try {
        const response = await fetch('/api/health', { signal: controller.signal })
        if (!response.ok) throw new Error(`Health check failed: ${response.status}`)

        const health = (await response.json()) as { status: string }
        setServerStatus(health.status === 'ok' ? 'connected' : 'unavailable')
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setServerStatus('unavailable')
        }
      }
    }

    void checkServer()
    return () => controller.abort()
  }, [])

  return (
    <main>
      <p className="eyebrow">Pi Nest</p>
      <h1>Project-first workspace for Pi</h1>
      <p>Local server: {serverStatus}</p>
    </main>
  )
}

export default App
