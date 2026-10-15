import { Select as SelectPrimitive } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from 'cn'

export function Select({ label, value, options, onValueChange, disabled, className }: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onValueChange: (value: string) => void
  disabled?: boolean
  className?: string
}) {
  return <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
    <SelectPrimitive.Trigger aria-label={label} className={cn('flex h-10 w-full max-w-full items-center justify-between gap-3 rounded-md border bg-background px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:w-72', className)}>
      <span className="truncate"><SelectPrimitive.Value placeholder="请选择" /></span><SelectPrimitive.Icon><ChevronDown size={16} aria-hidden="true" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal><SelectPrimitive.Content position="popper" side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-[60] max-h-[min(20rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
      <SelectPrimitive.Viewport className="p-1">{options.map((option) => <SelectPrimitive.Item key={option.value} value={option.value} className="relative flex cursor-default items-center rounded-sm py-2 pr-3 pl-8 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground">
        <SelectPrimitive.ItemIndicator className="absolute left-2"><Check size={14} aria-hidden="true" /></SelectPrimitive.ItemIndicator><SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
      </SelectPrimitive.Item>)}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content></SelectPrimitive.Portal>
  </SelectPrimitive.Root>
}
