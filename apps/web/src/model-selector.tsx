import { useState } from 'react'
import { Check } from 'lucide-react'
import type { PiRuntimeModel, PiRuntimeState } from '@pi-nest/contracts'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'

type ModelSelectorProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  models: PiRuntimeModel[]
  currentModel: PiRuntimeState['model']
  status: 'unloaded' | 'loading' | 'ready' | 'error' | 'switching'
  error?: string
  isActive: boolean
  onRetry: () => void
  onSelect: (provider: string, modelId: string) => Promise<boolean>
}

export function ModelSelector({ open, onOpenChange, models, currentModel, status, error, isActive, onRetry, onSelect }: ModelSelectorProps) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLocaleLowerCase()
  const filtered = models.filter((model) => `${model.name ?? ''} ${model.provider} ${model.id}`.toLocaleLowerCase().includes(query))
  const groups = [...new Set(filtered.map((model) => model.provider))].sort()
  const busy = status === 'loading' || status === 'switching'
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="space-y-5 overflow-y-auto p-4" side="right">
        <SheetTitle className="pr-8 font-semibold">选择模型</SheetTitle>
        <SheetDescription>更改当前会话使用的模型。</SheetDescription>
        <input autoFocus aria-label="搜索模型" className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="搜索名称、模型 ID 或提供商" value={search} onChange={(event) => setSearch(event.target.value)} />
        {currentModel?.id && currentModel.provider && <p className="break-all text-sm text-muted-foreground">当前模型：{currentModel.provider}/{currentModel.id}</p>}
        {isActive && <p className="text-sm text-muted-foreground">正在生成，结束后可切换模型。{models.length === 0 ? '结束后点击刷新读取模型列表。' : ''}</p>}
        {busy && <p role="status" className="text-sm">{status === 'switching' ? '正在切换模型…' : '正在读取模型…'}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button disabled={busy || isActive} onClick={onRetry} variant="outline">{status === 'error' ? '重试' : '刷新模型列表'}</Button>
        {status === 'ready' && models.length === 0 && <p className="text-sm text-muted-foreground">Pi 没有返回可用模型，请检查 Pi 的提供商与凭据配置后重试。</p>}
        {models.length > 0 && filtered.length === 0 && <p className="text-sm text-muted-foreground">没有匹配的模型。</p>}
        {groups.map((provider) => <section className="space-y-2" key={provider}>
          <h3 className="text-sm font-medium">{provider}</h3>
          {filtered.filter((model) => model.provider === provider).map((model) => {
            const selected = currentModel?.provider === model.provider && currentModel.id === model.id
            return <Button aria-label={`选择 ${model.provider}/${model.id}${selected ? '，当前模型' : ''}`} aria-pressed={selected} className="h-auto min-h-10 w-full justify-between whitespace-normal text-left" disabled={busy || isActive || selected} key={model.id} onClick={() => void onSelect(model.provider, model.id).then((changed) => { if (changed) onOpenChange(false) })} variant={selected ? 'secondary' : 'outline'}>
              <span className="min-w-0"><span className="block">{model.name ?? model.id}</span><span className="block break-all text-xs text-muted-foreground">{model.id}</span></span>
              {selected && <Check aria-hidden="true" className="size-4 shrink-0" />}
            </Button>
          })}
        </section>)}
      </SheetContent>
    </Sheet>
  )
}
