import type { ComponentProps } from 'react'
import { Link } from 'react-router'
import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SessionNavigation } from './session-navigation.js'
import { useWorkspaceStore } from './workspace-store.js'

export function WorkspaceNavigation({ settingsHref, ...props }: ComponentProps<typeof SessionNavigation> & { settingsHref: string }) {
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  return <div className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1"><SessionNavigation {...props} /></div>
    <footer className="shrink-0 space-y-1 border-t p-3">
      <Button asChild className="w-full justify-start" size="sm" variant="ghost"><Link to={settingsHref} onClick={() => setNavigationOpen(false)}><Settings aria-hidden="true" />设置</Link></Button>
    </footer>
  </div>
}
