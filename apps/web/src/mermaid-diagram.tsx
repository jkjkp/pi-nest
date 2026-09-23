import { useEffect, useId, useState } from 'react'
import { Maximize2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

const maxSourceLength = 32 * 1024

function useDarkMode() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setDark(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return dark
}

function themeVariables(dark: boolean) {
  return dark
    ? { background: '#202020', lineColor: '#9a9a9a', primaryBorderColor: '#3b82f6', primaryColor: '#292929', primaryTextColor: '#f1f1f1', secondaryColor: '#303030', tertiaryColor: '#202020' }
    : { background: '#ffffff', lineColor: '#6b7280', primaryBorderColor: '#3b82f6', primaryColor: '#eff6ff', primaryTextColor: '#1f2937', secondaryColor: '#f8fafc', tertiaryColor: '#ffffff' }
}

function safeSvg(purifier: { sanitize: (svg: string, options: Record<string, unknown>) => string }, svg: string) {
  return purifier.sanitize(svg, {
    FORBID_ATTR: ['href', 'target', 'xlink:href'],
    FORBID_TAGS: ['a', 'foreignObject', 'iframe', 'image', 'script'],
    USE_PROFILES: { svg: true, svgFilters: true },
  })
}

function DiagramMarkup({ svg }: { svg: string }) {
  return <div className="[&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
}

export function MermaidDiagram({ source }: { source: string }) {
  const [open, setOpen] = useState(false)
  const [rendered, setRendered] = useState<{ dark: boolean; error?: string; source: string; svg?: string }>()
  const dark = useDarkMode()
  const id = useId().replaceAll(':', '')
  const current = rendered?.source === source && rendered.dark === dark ? rendered : undefined

  useEffect(() => {
    let cancelled = false
    if (source.length > maxSourceLength) return
    void Promise.all([import('mermaid'), import('dompurify')]).then(async ([{ default: mermaid }, { default: purifier }]) => {
      mermaid.initialize({
        flowchart: { htmlLabels: false },
        maxEdges: 500,
        maxTextSize: maxSourceLength,
        securityLevel: 'strict',
        startOnLoad: false,
        theme: 'base',
        themeVariables: themeVariables(dark),
      })
      const result = await mermaid.render(`pi-nest-mermaid-${id}`, source)
      if (!cancelled) setRendered({ dark, source, svg: safeSvg(purifier, result.svg) })
    }).catch(() => { if (!cancelled) setRendered({ dark, error: '图表无法渲染。', source }) })
    return () => { cancelled = true }
  }, [dark, id, source])

  if (source.length > maxSourceLength || current?.error) return <div className="my-3"><pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs leading-6"><code>{source}</code></pre><p className="mt-2 text-sm text-destructive">{current?.error ?? '图表源码超过 32 KiB 上限。'}</p></div>
  if (!current?.svg) return <div className="my-3 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">正在生成 Mermaid 图表…</div>

  return (
    <figure className="my-3 rounded-md border bg-card p-3">
      <figcaption className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
        Mermaid 图表
        <Button aria-label="放大查看 Mermaid 图表" onClick={() => setOpen(true)} size="icon-xs" title="放大查看" type="button" variant="ghost"><Maximize2 /></Button>
      </figcaption>
      <div className="max-h-60 overflow-auto"><DiagramMarkup svg={current.svg} /></div>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="flex h-[90vh] w-[90vw] max-w-none flex-col p-4">
          <DialogTitle>Mermaid 图表</DialogTitle>
          <DialogDescription>放大查看当前助手正文中的图表。</DialogDescription>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/20 p-4"><DiagramMarkup svg={current.svg} /></div>
        </DialogContent>
      </Dialog>
    </figure>
  )
}
