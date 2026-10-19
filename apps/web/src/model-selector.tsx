import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Cpu, RefreshCw, X } from 'lucide-react'
import { Dialog, Popover } from 'radix-ui'
import type { PiRuntimeModel, PiRuntimeState } from '@pi-nest/contracts'
import { filterModels } from './model-search.js'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

type ModelSelectorProps = {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  label: string
  title: string
  disabled: boolean
  models: PiRuntimeModel[]
  currentModel: PiRuntimeState['model']
  status: 'unloaded' | 'loading' | 'ready' | 'error' | 'switching'
  error?: string
  isActive: boolean
  onLoad: () => void
  onRetry: () => void
  onSelect: (provider: string, modelId: string) => Promise<boolean>
}

export function ModelSelector({ label, title, disabled, models, currentModel, status, error, isActive, onLoad, onRetry, onSelect, open: controlledOpen, onOpenChange }: ModelSelectorProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  function setOpen(next: boolean) { setLocalOpen(next); onOpenChange?.(next) }
  const [mobile, setMobile] = useState(false)
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState(0)
  const listId = useId()
  const mobileContentRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const filtered = filterModels(models, search)
  const busy = status === 'loading' || status === 'switching'
  const selectionPending = useRef(false)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)')
    const update = () => setMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  function revealKeyboardOption(index: number) {
    const list = listRef.current
    const item = list?.querySelector<HTMLElement>(`[data-model-index="${index}"]`)
    if (!list || !item) return
    const viewport = list.getBoundingClientRect()
    const row = item.getBoundingClientRect()
    if (row.top < viewport.top) list.scrollTop += row.top - viewport.top
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom
  }

  function changeOpen(next: boolean) {
    setOpen(next)
    if (next) {
      setSearch('')
      setHighlight(0)
      onLoad()
    }
  }

  function refresh() {
    setHighlight(0)
    onRetry()
  }

  async function choose(model: PiRuntimeModel) {
    if (busy || isActive || selectionPending.current) return
    if (model.id === currentModel?.id && model.provider === currentModel.provider) return setOpen(false)
    selectionPending.current = true
    try {
      if (await onSelect(model.provider, model.id)) setOpen(false)
    } finally { selectionPending.current = false }
  }

  const trigger = <Button aria-label={`选择模型：${title}`} data-composer-tooltip={title} className="composer-model w-28 min-w-0 sm:w-48 text-foreground" disabled={disabled} title={title} size="sm" type="button" variant="ghost"><Cpu aria-hidden="true" className="composer-control-icon hidden" /><span className="composer-control-label min-w-0 truncate">{label}</span><ChevronDown aria-hidden="true" className="composer-control-chevron text-muted-foreground" /></Button>
  const contents = <>
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-2">
      <input aria-label="搜索模型" aria-controls={listId} aria-activedescendant={filtered[highlight] ? `${listId}-${highlight}` : undefined} aria-expanded={open} aria-autocomplete="list" role="combobox" className="h-9 min-w-0 flex-1 rounded-md bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="搜索模型或厂商…" value={search} onChange={(event) => { setSearch(event.target.value); setHighlight(0); if (listRef.current) listRef.current.scrollTop = 0 }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || !filtered.length) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next = (highlight + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length
          setHighlight(next)
          revealKeyboardOption(next)
        }
        if (event.key === 'Enter' && filtered[highlight]) { event.preventDefault(); void choose(filtered[highlight]) }
      }} />
      <Button aria-label="刷新模型列表" title="刷新模型列表" disabled={busy || isActive} onClick={refresh} size="icon-sm" variant="ghost"><RefreshCw aria-hidden="true" className={busy ? 'animate-spin' : ''} /></Button>
      {mobile && <Button aria-label="关闭模型选择" onClick={() => setOpen(false)} size="icon-sm" variant="ghost"><X aria-hidden="true" /></Button>}
    </div>
    <div ref={listRef} role="listbox" aria-label="可用模型" id={listId} className="model-list-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
      {(status === 'loading' || (status === 'unloaded' && !isActive)) && !models.length && <div aria-label="正在读取模型" aria-busy="true" className="space-y-3 p-2">{Array.from({ length: 5 }, (_, index) => <Skeleton className="h-12" key={index} />)}</div>}
      {error && <div role="alert" className="flex items-center gap-2 p-3 text-xs text-destructive"><span className="min-w-0 flex-1 break-words">{error}</span><Button disabled={busy || isActive} onClick={refresh} size="xs" variant="ghost">重试</Button></div>}
      {isActive && <p className="p-3 text-xs text-muted-foreground">生成结束后可切换{!models.length ? '，并刷新模型列表' : ''}。</p>}
      {filtered.map((model, index) => {
        const selected = currentModel?.provider === model.provider && currentModel.id === model.id
        const groupStart = index === 0 || filtered[index - 1]?.provider !== model.provider
        return <div key={`${model.provider}:${model.id}`} role="presentation">
          {groupStart && <p role="presentation" className="px-2 pb-1 pt-2 text-xs font-normal text-muted-foreground">{model.provider}</p>}
          <button id={`${listId}-${index}`} role="option" aria-selected={selected} aria-label={`${model.provider}/${model.id}${selected ? '，当前模型' : ''}`} data-model-index={index} disabled={busy || isActive} className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${highlight === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`} onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
              event.preventDefault()
              const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length
              setHighlight(next)
              revealKeyboardOption(next)
              listRef.current?.querySelector<HTMLButtonElement>(`[data-model-index="${next}"]`)?.focus({ preventScroll: true })
            }} onFocus={() => setHighlight(index)} onPointerMove={() => setHighlight(index)} onClick={() => void choose(model)}>
            <span className="min-w-0 flex-1"><span className="block truncate">{model.name ?? model.id}</span>{model.name && model.name !== model.id && <span className="block truncate text-xs text-muted-foreground">{model.id}</span>}</span>
            {selected && <Check aria-hidden="true" className="size-4 shrink-0" />}
          </button>
        </div>
      })}
      {status === 'ready' && !models.length && <p className="p-3 text-sm text-muted-foreground">没有可用模型，请检查 Pi 的提供商与凭据配置。</p>}
      {!!models.length && !filtered.length && <p className="p-3 text-sm text-muted-foreground">没有匹配的模型。</p>}
    </div>

  </>

  if (mobile) return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
      <Dialog.Content ref={mobileContentRef} className="fixed inset-x-0 bottom-0 z-50 flex h-[min(360px,60dvh)] flex-col rounded-t-xl border bg-popover pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-xl outline-none" onOpenAutoFocus={(event) => { event.preventDefault(); if (listRef.current) listRef.current.scrollTop = 0; mobileContentRef.current?.focus({ preventScroll: true }) }} onCloseAutoFocus={(event) => event.preventDefault()}>
        <Dialog.Title className="sr-only">选择模型</Dialog.Title><Dialog.Description className="sr-only">更改当前会话使用的模型。</Dialog.Description>
        {contents}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>

  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
    <Popover.Portal><Popover.Content onOpenAutoFocus={() => { if (listRef.current) listRef.current.scrollTop = 0 }} aria-label="选择模型" side="top" align="end" sideOffset={8} collisionPadding={12} className="z-50 flex h-[min(360px,var(--radix-popover-content-available-height))] w-[340px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl outline-none">{contents}</Popover.Content></Popover.Portal>
  </Popover.Root>
}
