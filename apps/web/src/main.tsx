import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider } from 'react-router'
import './index.css'
import App from './App.tsx'
import { RouteErrorPage } from './route-error-page.js'
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

const router = createBrowserRouter([{ path: '*', element: <App runtime={runtime} sessionRuns={sessionRunController} />, errorElement: <RouteErrorPage /> }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
