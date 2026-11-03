import { PanelLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function NavigationToggle({ expanded, onToggle, controls, className = '' }: {
  expanded: boolean; onToggle: () => void; controls: string; className?: string
}) {
  const label = expanded ? '收起侧边栏' : '展开侧边栏'
  return <TooltipProvider><Tooltip><TooltipTrigger asChild>
    <Button type="button" variant="ghost" size="icon-sm" aria-label={label} aria-expanded={expanded} aria-controls={controls} onClick={onToggle}
      className={`appearance-none border-0 shadow-none aria-expanded:bg-transparent hover:aria-expanded:bg-muted focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${className}`}><PanelLeft aria-hidden="true" className="size-4.5" /></Button>
  </TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip></TooltipProvider>
}
