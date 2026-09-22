import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { sessionHistoryQueryKey } from './history.js'
import { RuntimeWebSocketClient } from './runtime-websocket-client.js'
import { createSessionRunController } from './session-run-controller.js'

const queryClient = new QueryClient()
const runtime = new RuntimeWebSocketClient()
const sessionRunController = createSessionRunController({
  invalidateHistory: (sessionId) => queryClient.invalidateQueries({ queryKey: sessionHistoryQueryKey(sessionId) }),
  runtime,
})
sessionRunController.resume()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App runtime={runtime} sessionRuns={sessionRunController} />
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
)
