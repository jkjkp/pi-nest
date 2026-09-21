import { Navigate, Route, Routes } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'

import type { SessionRunController } from './session-run-controller.js'
import { WorkspacePage } from './workspace-page.js'

function App({ sessionRuns }: { sessionRuns: SessionRunController }) {
  return (
    <TooltipProvider>
      <Routes>
        <Route path="/" element={<WorkspacePage sessionRuns={sessionRuns} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TooltipProvider>
  )
}

export default App
