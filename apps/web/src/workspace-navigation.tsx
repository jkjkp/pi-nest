import type { ComponentProps } from 'react'
import { Link } from 'react-router'
import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SessionNavigation } from './session-navigation.js'
import { useWorkspaceStore } from './workspace-store.js'

export function WorkspaceNavigation({ settingsHref, ...props }: ComponentProps<typeof SessionNavigation> & { settingsHref: string }) {
  const setNavigationOpen = useWorkspaceStore((state) => state.setNavigationOpen)
  return <div className="flex h-full min-h-0 flex-col text-sm font-normal">
    <div className="min-h-0 flex-1"><SessionNavigation {...props} /></div>
    <footer className="shrink-0 border-t p-3">
      <Button asChild className="min-h-10 w-full justify-start gap-2 rounded-md px-2 py-2 text-sm" size="sm" variant="ghost"><Link to={settingsHref} onClick={() => setNavigationOpen(false)}><Settings aria-hidden="true" className="size-3" />设置</Link></Button>
    </footer>
  </div>
}
