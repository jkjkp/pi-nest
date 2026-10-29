import { Navigate, Route, Routes, useSearchParams } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'

import type { SessionRunController } from './session-run-controller.js'
import type { RuntimeWebSocketClient } from './runtime-websocket-client.js'
import { RuntimeExtensionUi } from './runtime-extension-ui.js'
import { WorkspacePage } from './workspace-page.js'
import { SettingsPage } from './settings-page.js'

function App({ runtime, sessionRuns }: { runtime: RuntimeWebSocketClient; sessionRuns: SessionRunController }) {
  const [searchParams] = useSearchParams()
  return (
    <TooltipProvider>
      <RuntimeExtensionUi runtime={runtime} sessionRuns={sessionRuns} activeSessionId={searchParams.get('session') ?? ''}>
        <Routes>
          <Route path="/" element={<WorkspacePage sessionRuns={sessionRuns} />} />
          <Route path="/settings/:category?" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </RuntimeExtensionUi>
    </TooltipProvider>
  )
}

export default App
