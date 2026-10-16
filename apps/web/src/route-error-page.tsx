import { useEffect } from 'react'
import { useRouteError } from 'react-router'
import { Button } from '@/components/ui/button'

export function RouteErrorPage() {
  const error = useRouteError()
  useEffect(() => { console.error('Workspace route render failed', { name: error instanceof Error ? error.name : 'RouteError' }) }, [error])
  return <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
    <section className="max-w-md space-y-4"><h1 className="text-lg font-semibold">页面暂时无法显示</h1>
      <p className="text-sm text-muted-foreground">可以重新加载页面恢复连接。不会自动重发消息。</p>
      <Button type="button" onClick={() => window.location.reload()}>重新加载页面</Button>
    </section>
  </main>
}
