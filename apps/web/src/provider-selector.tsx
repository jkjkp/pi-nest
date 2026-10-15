import { useId, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { Popover } from 'radix-ui'
import { filterModels } from './model-search.js'

export function ProviderSelector({ providers, value, disabled, onValueChange }: {
  providers: readonly { id: string; name: string }[]
  value: string
  disabled?: boolean
  onValueChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const filtered = filterModels(providers.map((provider) => ({ ...provider, provider: provider.id })), search)
  const selected = providers.find((provider) => provider.id === value)
  function choose(id: string) { if (id !== value) onValueChange(id); setOpen(false) }
  function reveal(index: number) {
    const row = list.current?.querySelector<HTMLElement>(`[data-provider-index="${index}"]`)
    if (!row || !list.current) return
    if (row.offsetTop < list.current.scrollTop) list.current.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > list.current.scrollTop + list.current.clientHeight) list.current.scrollTop = row.offsetTop + row.offsetHeight - list.current.clientHeight
  }
  return <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) { setSearch(''); setHighlight(0) } }}>
    <Popover.Trigger asChild><button type="button" aria-label="提供商" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled} className="flex h-10 w-full max-w-full items-center justify-between gap-3 rounded-md border bg-background px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:w-72"><span className="truncate">{selected ? `${selected.name || selected.id} (${selected.id})` : '请选择提供商'}</span><ChevronDown className="shrink-0" size={16} aria-hidden="true" /></button></Popover.Trigger>
    <Popover.Portal><Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={8} aria-label="选择提供商" onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus() }} className="z-[60] flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2"><Search size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" /><input ref={input} aria-label="搜索提供商" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={filtered[highlight] ? `${listId}-${highlight}` : undefined} value={search} placeholder="搜索名称或 Provider ID…" className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none" onChange={(event) => { setSearch(event.target.value); setHighlight(0); if (list.current) list.current.scrollTop = 0 }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') { event.preventDefault(); if (filtered[highlight]) choose(filtered[highlight].id) }
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && filtered.length) {
          event.preventDefault()
          const next = (highlight + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length
          setHighlight(next); reveal(next)
        }
      }} /></div>
      <div ref={list} id={listId} role="listbox" aria-label="提供商列表" className="relative min-h-0 overflow-y-auto overscroll-contain p-1">{filtered.map((provider, index) => <button key={provider.id} id={`${listId}-${index}`} data-provider-index={index} type="button" role="option" tabIndex={-1} aria-selected={provider.id === value} onMouseMove={() => setHighlight(index)} onClick={() => choose(provider.id)} className={`flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm outline-none ${highlight === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`}><span className="min-w-0 flex-1 break-words">{provider.name || provider.id} ({provider.id})</span>{provider.id === value && <Check size={14} className="shrink-0" aria-hidden="true" />}</button>)}</div>
      {!filtered.length && <p role="status" className="p-4 text-sm text-muted-foreground">没有匹配的提供商。</p>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
