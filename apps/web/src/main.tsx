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

function bootstrap() {
  const queryClient = new QueryClient()
  const runtime = new RuntimeWebSocketClient()
  const sessionRunController = createSessionRunController({
    invalidateHistory: (sessionId) => queryClient.invalidateQueries({ queryKey: sessionHistoryQueryKey(sessionId) }),
    runtime,
  })
  sessionRunController.resume()
  return { queryClient, runtime, sessionRunController, root: createRoot(document.getElementById('root')!) }
}

const previous = import.meta.hot?.data.bootstrap as (ReturnType<typeof bootstrap> & { router?: ReturnType<typeof createBrowserRouter> }) | undefined
const application = previous ?? bootstrap()
const { queryClient, runtime, sessionRunController, root } = application
const router = previous?.router ?? createBrowserRouter([{ path: '*', element: <App runtime={runtime} sessionRuns={sessionRunController} />, errorElement: <RouteErrorPage /> }])
if (import.meta.hot) import.meta.hot.data.bootstrap = { ...application, router }

if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.accept(['./runtime-websocket-client.js', './session-run-controller.js'], () => import.meta.hot?.invalidate())
}

root.render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
